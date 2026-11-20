# A party of four: 3 characters + a merchant

One game container, four client containers, one party. The fighters share a target, the priest keeps
everyone alive, and the merchant does the only thing a merchant can do: buff luck, take the loot and
sell it.

```sh
docker compose -f examples/party/docker-compose.yml up -d
docker compose -f examples/party/docker-compose.yml logs -f
docker compose -f examples/party/docker-compose.yml down -v
```

Podman works the same way (`podman compose` or `podman-compose`, same file). The first start clones the
pinned game repositories inside the `al-clone` volume, which takes a few minutes and needs network;
after that a start is ~20 seconds.

Watch any of them in a browser: <http://127.0.0.1:18090/?watch=PartyTank> (or `PartyMage`,
`PartyPriest`, `PartyMerch`).

## What runs

| service | character | class | loop | job |
| --- | --- | --- | --- | --- |
| `al-game` | – | – | – | MongoDB + account backend + game server, the fixtures, and a test sell point |
| `al-tank` | PartyTank | warrior | `loops/party/leader.mjs` | owns the party, invites the others, focus-fires, opens chests, hands loot over |
| `al-mage` | PartyMage | mage | `loops/party/fighter.mjs` | same combat loop over **MessagePack** (both wire formats in one party) |
| `al-priest` | PartyPriest | priest | `loops/party/priest.mjs` | party heal, single-target heal, mana upkeep |
| `al-merchant` | PartyMerch | merchant | `loops/party/merchant.mjs` | Merchant's Luck on the fighters, receives their loot, sells it |

All four characters live on **one account** (`party@example.test`) and start around `(-100,800)` on
`main` - inside the goo field, and inside both the item-transfer radius (`B.dist` 400) and the sell
radius (`B.sell_dist` 400) of the test merchant at `(-193,680)`.

Three fighters and a merchant on one account is legal: the server's per-account character limit skips
merchants (`node/server_functions.js`, the check that counts `players[id].owner`), and the class
description says as much.

## Why the party looks like this

Four game rules, read from the pinned server (`node/server.js`) and the game data; each one is a
decision in the loops, and getting one wrong is how a "party" becomes four characters in a room:

| rule | proof | what the example does |
| --- | --- | --- |
| a merchant's attack is refused | `commence_attack` → `{ failed: true, reason: "merchant" }` | the merchant never swings; it buffs (`mluck`, merchant-only, level 40, range 320) and trades |
| a party chest splits items by damage share, and a merchant's share is 0 | `party_to_client` sets `share = 0` for merchants; `open_chest` rolls by `share` | loot reaches the merchant by `send` (item transfer, same map, within 400), not by looting |
| a loot pile must be **opened** | `socket.on("open_chest")` is the only thing that grants a chest's contents | every loop opens the piles it walks to (the solo bot did not, and silently looted nothing) |
| selling needs a merchant within 400 | `socket.on("sell")` iterates `G.maps[map].merchants` | the game image injects a test sell point, because upstream ships none at all |

Focus fire needs no coordinator: every member runs the same pure function over its own view (closest
to the anchor in 25-unit buckets, then lowest hp, then id - positions are what every member sees
identically, hp is not), so they converge on one monster and the party's damage share - which decides
who gets the drops - stays high.

## Configuration

Everything has a default, so the file runs as-is. Copy `.env.example` to `.env` next to the compose
file to change it:

| variable | default | meaning |
| --- | --- | --- |
| `AL_PARTY_EMAIL` / `AL_PARTY_PASSWORD` | `party@example.test` / `party-password-123` | the account the game container creates and all four clients use |
| `AL_PARTY_API_PORT` / `AL_PARTY_GAME_PORT` | `18090` / `17192` | host ports (the stack deliberately avoids 8090/7192) |
| `AL_GAME_IMAGE` / `AL_CLIENT_IMAGE` | the GHCR `:latest` tags | pin `sha-<short>` tags for reproducible runs; build locally and override to test your own loops |
| `AL_TEST_MERCHANT` | `main:-193,680` | `off` keeps the stack's maps merchant-less (nothing can sell); `map:x,y` moves the sell point |

The party wiring itself (`AL_PARTY_LEADER`, `AL_PARTY_MEMBERS`, `AL_PARTY_MERCHANT`,
`AL_PARTY_ANCHOR`, `AL_PARTY_SELL_AT`, `AL_PARTY_SEND_AT`, `AL_PARTY_SELL_AT_FILL`,
`AL_PARTY_HEAL_BELOW`) is documented in [`loops/party/README.md`](../../loops/party/README.md).

## What the logs look like

```
al-tank       | [party:leader] party ready: PartyTank, PartyMage, PartyPriest, PartyMerch
al-tank       | [party:leader] engaging goo45 at 92 units
al-tank       | [party:leader] opened a chest: 1 items, 12 gold
al-tank       | [party:leader] sent 3x gslime to PartyMerch
al-priest     | [party:priest] partyheal: 27% on PartyTank
al-mage       | [party:fighter] engaging goo45 at 141 units
al-merchant   | [party:merchant] received 3x gslime from PartyTank
al-merchant   | [party:merchant] cast Merchant's Luck on PartyTank
al-merchant   | [party:merchant] sold 19 items for 64 gold (64 total)
```

Each client prints a `summary {json}` line on shutdown, so a run can be measured instead of read.

## Troubleshooting

| symptom | cause |
| --- | --- |
| the clients log `waiting for ...` for minutes | the game container is still cloning and installing the pinned repositories (first start only); it reports healthy only once the fixtures are applied |
| `party still incomplete` | a member is not online yet; the leader keeps inviting, and members keep requesting |
| `send ... refused: distance` | the merchant is more than 400 units away - the fighter walks to it first |
| `sell ... failed: distance` | no merchant within 400: the stack was started with `AL_TEST_MERCHANT=off` |
| `partyheal refused: no_mp` | the priest is below 400 mp and drinks for mana first |
| `reached_character_limit` in the game logs | the account already has five characters - this example uses four on its own account |
| ports already in use | another Adventure Land stack is running; change `AL_PARTY_API_PORT`/`AL_PARTY_GAME_PORT` |
| a character is stuck or invisible | a ghost from a killed run; `down -v` (the clone is rebuilt) or restart the stack |

## Swapping in your own loops

The client image loads loops by path, so you can iterate without rebuilding:

```yaml
  al-merchant:
    image: ${AL_CLIENT_IMAGE:-ghcr.io/dionjones615/adventureland-client:latest}
    volumes:
      - ../../loops:/app/loops:ro
```

A loop is any ES module that exports `run(context)` or `decide(state)` - see
[`loops/README.md`](../../loops/README.md) and [`loops/party/README.md`](../../loops/party/README.md).
