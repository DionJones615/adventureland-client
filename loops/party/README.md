# Party loops: three characters and a merchant that work together

Four loops, four characters, one party. Each file runs under the same runner as `basic.mjs`
(`scripts/bot.mjs`), so a party is just four containers with different `BOT_LOOP` values:

| file | role | what it does |
| --- | --- | --- |
| `leader.mjs` | party owner | invites the members, focus-fires the shared target, opens loot chests, hands the bag to the merchant |
| `fighter.mjs` | second damage dealer | the same body as the leader, but it asks to join instead of inviting |
| `priest.mjs` | healer | `partyheal` when the group is hurt, `heal` for one target, mana upkeep, damage otherwise |
| `merchant.mjs` | trader | casts Merchant's Luck on the fighters, receives their loot, sells it at a merchant |
| `hold.mjs` | none | joins the party and stands still: no movement, no attacks, no loot, no trade - the safe first run on a real server |

The full container example is [`examples/party/`](../../examples/party/); run it with
`docker compose -f examples/party/docker-compose.yml up -d`.

## The four game rules these loops are built on

All of them are read from `reference/upstream/node/server.js` and the game data, and each one shapes a
decision that is easy to get wrong:

1. **A merchant cannot attack.** `commence_attack` refuses it (`reason: "merchant"`), and monsters
   award a merchant no xp. So the merchant role never swings: it buffs and it trades.
2. **A party chest splits items by damage share.** `open_chest` picks a winner per item weighted by
   `player.share`, and a merchant's share is always 0. A merchant therefore never loots a chest -
   loot reaches it as an item transfer (`send`, same map, within `B.dist` 400).
3. **Loot piles are opened, not collected.** Walking over a `drop` packet does nothing; the server
   grants its contents to `open_chest`. The runner fixes this for the solo loop too.
4. **A merchant has to exist on the map for anything to be sold.** Upstream ships no `merchants`
   arrays at all, so the game image injects a test sell point (see the
   [container](https://github.com/DionJones615/adventureland-container)); the loops are told where it
   is by `AL_PARTY_SELL_AT`.

## Safety gates for a real account

The party was written against a throwaway stack; every loop therefore takes four switches that are off
(or open) locally and on in [../../examples/live-party/](../../examples/live-party/). They all live in
`partySettings` (`loops/party/lib.mjs`) and come from the runner's party config:

| switch | env | effect |
| --- | --- | --- |
| `targets` | `AL_PARTY_TARGETS` | `focusTarget` refuses any monster whose type is not listed |
| `ownLoot` | `AL_PARTY_OWN_LOOT=1` | a loot pile is opened only within 2.5 s of one of our own kills |
| `sendEnabled` | `AL_PARTY_SEND=off` | fighters never hand their bag to the merchant |
| `sellEnabled` + `keepSell` | `AL_PARTY_SELL=off`, `AL_PARTY_KEEP` | nothing is sold, or only what is not matched by a keep pattern |

## Focus fire without a coordinator

There is no shared channel, no leader broadcast and no extra service. Every member runs the same pure
function over its own entity view (`scripts/bot/party.mjs`, `focusTarget`):

> among monsters within `focusChase` of the **configured anchor**: closest to the anchor first (in
> 25-unit buckets, because positions are what every member sees identically), then lowest hp, then the
> smallest id.

Two clients that see the same monsters and share the anchor compute the same target, so the group
converges on one monster and its damage share (and everyone's drop rolls) stay high. Party chat exists
(`say` with `party: true` → `partym`) and the loops use it for status lines, not for combat calls.

## Joining a party

`ensureParty` (in `scripts/bot/party.mjs`) does both directions, because either side can boot first:

| who | does |
| --- | --- |
| the leader | invites every wanted member that is online, and answers `request` with `raccept` |
| a member | sends `request` to the leader, and answers the leader's `invite` with `accept` |

The roster is verified from `party_update` (`world.party`), never assumed. A character left in a party
by an aborted run sends `leave` once first. The handshake watcher stays installed after joining, so a
member that boots late can still join; `maintainParty` re-invites anyone missing every 10 s. A party
only learns its roster from `party_update` - membership changes and a once-a-minute broadcast - which
is why the loops wait for it instead of trusting their own view.

## Configuration

Every knob is an env var on the client image (or the matching `--party-*` flag):

| variable | default | meaning |
| --- | --- | --- |
| `AL_PARTY_LEADER` | – | the character that owns the party |
| `AL_PARTY_MEMBERS` | – | comma list the leader invites (include the leader) |
| `AL_PARTY_MERCHANT` | – | the merchant that fighters hand loot to |
| `AL_PARTY_ANCHOR` | – | `x,y` the group fights around |
| `AL_PARTY_SELL_AT` | – | `x,y` of a merchant within 400 units |
| `AL_PARTY_SEND_AT` | `0.4` | bag fraction at which a fighter walks to the merchant |
| `AL_PARTY_SELL_AT_FILL` | `0.5` | bag fraction at which the merchant sells |
| `AL_PARTY_HEAL_BELOW` | `0.55` | hp fraction below which the priest heals |
| `AL_PARTY_ROLE` | – | reported in the summary line; the log prefix comes from the loop file |

## Running one by hand

```sh
node scripts/bot.mjs --character PartyTank --loop ./loops/party/leader.mjs --seconds 0 \
  --api http://127.0.0.1:8090 --address 127.0.0.1:7192 \
  --party-leader PartyTank --party-members PartyTank,PartyMage,PartyPriest,PartyMerch \
  --party-merchant PartyMerch --party-anchor -100,800 --party-sell-at -193,680
```

`--seconds 0` means "until SIGTERM" - the loops are long-lived. Any loop can be swapped for your own:
the contract is [../README.md](../README.md), and `lib.mjs` is where the shared pieces live.

## What the logs say

```
[party:leader] joining the party (leader PartyTank, members PartyTank, PartyMage, PartyPriest, PartyMerch)
[party:leader] party ready: PartyTank, PartyMage, PartyPriest, PartyMerch
[party:leader] opened a chest: 1 items, 12 gold
[party:leader] sent 3x gslime to PartyMerch
[party:priest] partyheal: 27% on PartyTank
[party:merchant] received 3x gslime from PartyTank
[party:merchant] cast Merchant's Luck on PartyTank
[party:merchant] sold 19 items for 64 gold (64 total)
```

## Failure modes worth knowing

| symptom | cause |
| --- | --- |
| `party still incomplete` | a member is not online yet (the leader keeps inviting), or the roster has not arrived |
| `already_in_party` | the character is already in that party; harmless |
| `send ... refused: distance` | the merchant is more than 400 units away - the fighter walks to it first |
| `sell ... failed: distance` | no merchant within 400 on this map: the stack has no sell point (see rule 4) |
| `loot refused: loot_no_space` | the bag filled up; the loop vendors before retrying |
| `partyheal refused: no_mp` | below 400 mp: the priest drinks for mana instead |
| nothing happens at all | two stacks share a port, or the character is a ghost from a killed run - restart the stack |
