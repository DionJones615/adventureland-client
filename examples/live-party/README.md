# The party on a real server, watched in the local client

The four characters of the party example can play on a real Adventure Land server while you watch
them in the **local** game client's watch view. The game server on this machine is still the renderer;
the entity data comes from the clients themselves.

    live server                     this machine
    +----------------+              +---------------------------------------------+
    | 4 game sockets |  ALClient    | scripts/live/party.mjs  (one login, 4 loops) |
    +----------------+ -----------> |   POST /snapshot, 5 Hz, per character        |
                                    +---------------------------------------------+
                                                    |
                                    scripts/live/relay.mjs  :7899  (merge, SSE)
                                                    |
                                    local client page  /?watch=<name>&relay=1
                                    (the game's own renderer, fed by EventSource)

## Why it is built this way

- **One login, four sockets.** Four independent logins look like four sessions to the account
  backend; the launcher logs in once and hands that session to the four clients.
- **No extra sockets to the game.** Watching through the game's observer handshake would mean one
  more connection per character. The party's own clients already receive every entity they need, so
  they post their world to the relay instead.
- **The browser never holds live credentials.** The account API of the real game sends no permissive
  CORS headers, so a page served from `127.0.0.1` cannot log in to it. The relay does the talking; the
  page reads plain SSE from the same machine and never leaves its origin.
- **The page is the local watch view, unchanged.** `scripts/local/local_watch.js` (in the game stack)
  gains one more source: instead of the local game server's stream it injects the relay's frames
  through `original_onevent`, the same path the server's own packets take. The renderer, the camera
  follow and every HUD panel are the game's own code.

## The two terminals and the browser

```sh
# 1. the relay (this repository)
npm run live:relay

# 2. the party, with the gates of live.env
npm run live:party -- --env examples/live-party/live.env --live --seconds 300

# 3. the view (the local game stack must be serving the patched client)
open 'http://127.0.0.1:8090/?watch=Dion6&relay=1'
```

The page follows the character named in `watch=`; the rest of the party is drawn around it, and the
roster panel lists all four with hp, mp, gold, bag fill and counters.

The panel's header has a **partywatch** chip: it frames the whole party - the camera centres on their
bounding box and the zoom pulls back until everyone fits, with the members' names drawn over the map.
Clicking any character row follows that character instead (normal zoom, stream re-opened on them);
clicking the chip again goes back to the group.

## Rehearse locally first

The exact same launcher and relay work against a throwaway stack, which is the way to learn the
workflow without touching an account:

```sh
npm run e2e:up                                     # the party stack: 18090 / 17192
npm run live:relay &
npm run live:party -- --env examples/live-party/local.env --api http://127.0.0.1:18090
open 'http://127.0.0.1:18090/?watch=PartyTank&relay=1'
npm run e2e:down
```

`AL_GAME_ADDRESS` is in `local.env` for a reason: a containerised stack advertises its own
`localhost:7192`, which is not where the host reaches it (and on a host stack the advertised
`localhost` may answer on IPv6 while the game listens on IPv4). `--address <host:port>` overrides it,
exactly like the bot runner's flag.

Against the same stack with its published ports:

```sh
npm run live:party -- --env examples/live-party/local.env --api http://127.0.0.1:18090 --address 127.0.0.1:17192
```

## What the live profile refuses to do

| gate | default here | why |
| --- | --- | --- |
| recipients of loot | nobody (`AL_PARTY_SEND=off`) | a fighter's bag holds gear and uniques, not just loot |
| selling | off (`AL_PARTY_SELL=off`) | the live sell path is unverified, and rarity is not recoverable |
| monsters | goos only (`AL_PARTY_TARGETS=goo`) | the weakest spawn in the field: even a level 34 priest survives it |
| loot piles | own kills only (`AL_PARTY_OWN_LOOT=1`) | a pile on a shared map may be someone else's |
| run length | `--seconds`, and `--max-deaths 3` | a bounded, supervised session, never a 24/7 farm |

Turn one of them on only after a live probe explains the answer: `AL_PARTY_SELL=on` with a
`AL_PARTY_KEEP` pattern list is the shape of a deliberate decision, not a default.

## Before a live run

1. `AL_USERNAME` / `AL_PASSWORD` in `live.env`, and every named character **offline** (the launcher
   refuses a character that is already online, because two sessions race for one document).
2. The character names and roles match the account's real characters.
3. The anchor is a place you are willing to stand: the default is the goo field of `main`, 100 units
   from the `standmerchant` NPC at `(-193,680)`.
4. `npm run live:relay` is up and `curl -s localhost:7899/health` answers.
5. The local stack serves the patched client (`node scripts/local/patch_client.mjs` in the game
   repository, or one restart of the stack) and `/?watch=<name>&relay=1` renders a local character
   first.

## Running it 24/7

A bounded run stops on its own; keeping the party up is a different contract, so it is a supervised
service rather than a long `--seconds`:

```sh
node scripts/live/service.mjs --env examples/live-party/live.env --live   # supervise by hand
node scripts/live/service.mjs --status                                    # child, restarts, relay health
```

The supervisor starts the relay if it is not answering, runs the party as a child with **no time limit
and no death cap** (`--seconds 0 --max-deaths -1`), and replaces the child when it exits or when the
relay has not seen all four characters publish for two minutes. Restarts back off 5s → 15s → 60s →
300s, and the log rotates at 5 MB (three copies) under `~/.local/state/adventureland-party/`.

The systemd unit in this directory is the way to survive logout and reboots:

```sh
cp examples/live-party/adventureland-party.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now adventureland-party.service
systemctl --user status adventureland-party.service
journalctl --user -u adventureland-party.service -f
```

Credentials come from `EnvironmentFile=%h/projects/adventure.land/.env` (the unit), not from the party
profile: `live.env` holds the gates and is safe to commit. To stop it:

```sh
systemctl --user disable --now adventureland-party.service   # party exits, characters log off
```

### Before you leave it running

The game states its own rule for accounts that run unattended, in its documentation:

> Accounts that never interact with the game yet operate 24/7 will be temporarily banned unless their
> merchants are social and active or the owner interacts with other players on Discord. It's enough to
> interact once every week on average. This is an anti-leech/multi-account rule, however the game is
> more fun for everyone this way too.

That is a rule about **you**, not about the code: a supervised party running for days while nobody
plays is exactly the case it names. The supervisor keeps the process alive; it cannot keep the account
in good standing. Sessions where you are present, and an interaction with the game or its Discord every
so often, are what the rule asks for.

## Stopping


`Ctrl-C` in the launcher sets `shouldStop` on every loop, stops the publishers and disconnects the
four sockets: the characters go offline. Nothing on the account is mutated by the default gates, so
there is nothing to undo; a character that died stays where it respawned and is picked up by the
normal game client.

## Caveats

- **Version skew.** The local client is a pinned clone (17810); the live game is newer (18285). The
  relay forwards only the fields the client understands, but a brand new entity field may not render.
- **Regen skills.** The pinned server only implements `use hp` / `use mp`. If the live server answers
  without moving hp, the fight is limited by natural regeneration - which is why the live profile
  fights the weakest spawn, not a chosen farm.
- **Deaths move characters** to their spawn point; the party keeps its roster, and the page shows the
  straggler walking back.
- **Anti-leech rules.** The game bans accounts that operate continuously without human interaction;
  this example is for short, supervised sessions.

## What has been seen working

| run | result |
| --- | --- |
| local stack, four characters, full loops, 150 s | 54 kills, 20 items handed to the merchant, 15 sold for 11,409 gold, no deaths, no failures |
| local stack, page `?watch=PartyTank&relay=1` | world, sprites, hits and the PARTY panel (4/4) rendered from the relay; 34 entities, camera following the tank |
| live `--hold`, 90 s, EU I | all four characters online in one party (4/4), published to the relay, rendered at `?watch=Dion6&relay=1` with live hp/mp/gold; all four offline again afterwards, positions unchanged |
| live, attacks | **not run yet.** The four characters are spread over `main` (up to ~2,700 units apart), so a fighting run first walks them to the anchor - that walk is the risky part and deserves a quiet corner of the map and a supervised window. Run it with `--seconds 300 --max-deaths 3` when you are ready to watch it. |
