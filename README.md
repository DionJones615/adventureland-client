# adventureland-client

Protocol client and bot runner for [Adventure Land](https://adventure.land), with **loop scripts you can mount into
the container** — a strategy is a plain ES module, not a rebuild.

```sh
docker run --rm --network al \
  -e AL_API=http://al-game:8090 -e AL_GAME_ADDRESS=al-game:7192 \
  -e AL_BOT_CHARACTER=E2EMage -e AL_BOT_SECONDS=120 \
  -v "$PWD/my-loops:/loops:ro,z" -e BOT_LOOP=/loops/aggressive.mjs \
  ghcr.io/dionjones615/adventureland-client:latest
```

It talks to the game stack from [adventureland-container](https://github.com/DionJones615/adventureland-container);
this repository's CI pulls that image and runs the e2e suite against it.

| what | where |
| --- | --- |
| protocol client (`client/`) | login, connect, entities, movement, actions, pathfinding, JSON + MessagePack |
| bot runner (`scripts/bot.mjs`) | account bootstrap, connect retries, action execution, counters, summary |
| loops (`loops/`) | `basic.mjs` (default) and the contract in [`loops/README.md`](loops/README.md) |
| text observer (`scripts/watch.mjs`) | ASCII view of an online character |

## Quick start

```sh
npm ci
npm run fetch-data                 # game data for pathfinding/attack ranges (from adventure.land)

# against a local game stack (or the container image on published ports)
npm run bot -- --character Devmage --seconds 120
npm run bot -- --character Devmage --loop ./my-loops/mine.mjs   # a custom loop
npm run watch -- Devmage                                        # text view
```

## Loops are mountable

The runner loads a loop by path, so the image needs no rebuild to change behaviour:

```sh
docker run --rm --network al -v "$PWD/my-loops:/loops:ro,z" -e BOT_LOOP=/loops/mine.mjs …
```

A loop exports **either** `decide(state)` — pure, returns an action the runner executes — **or**
`run({ client, log, counters, sleep, config })` for full control. The contract, the state shape, the action table and
a worked example are in [`loops/README.md`](loops/README.md).

## A party of four: 3 characters + a merchant

[examples/party/](examples/party/) is a full stack: the game container plus four client containers on one account,
playing together. Three fighters focus the same target, a priest keeps the group alive, and a
`merchant` - a class that the server refuses to let attack - buffs luck, receives the fighters' loot
and sells it.

```sh
docker compose -f examples/party/docker-compose.yml up -d
docker compose -f examples/party/docker-compose.yml logs -f
# watch one of them: http://127.0.0.1:18090/?watch=PartyTank
docker compose -f examples/party/docker-compose.yml down -v
```

The party is built out of four decisions the game actually supports (all sourced in
[loops/party/README.md](loops/party/README.md)):

| decision | why |
| --- | --- |
| focus fire by a **shared, deterministic target** (nearest to the anchor, then lowest hp, then id) | no chat round-trips and no coordination service: every client computes the same answer from its own view |
| the merchant **cannot fight** (`commence_attack` answers `attack_failed`), so it buffs and trades | that is the class, and it keeps the merchant out of the melee |
| loot moves by **sendItem**, not by looting | a party chest splits items by damage share, and a merchant's share is always 0 |
| selling needs a **merchant coordinate** | upstream ships no map merchants; the game image injects a test sell point (see [adventureland-container](https://github.com/DionJones615/adventureland-container)) |

Roles, logs and failure modes are in [examples/party/README.md](examples/party/README.md).

## The same party on a real server, watched locally

The party does not have to stay in a throwaway stack. [examples/live-party/](examples/live-party/) runs the four
characters on a real server while you watch them in the **local** game client's watch view - its own renderer,
camera follow and HUD panels, fed with live entity data instead of the local server's simulation.

```sh
npm run live:relay                                              # merge + SSE, 127.0.0.1:7899
npm run live:party -- --env examples/live-party/live.env --live --seconds 300
open 'http://127.0.0.1:8090/?watch=Dion6&relay=1'               # the local watch view
```

| piece | file | why |
| --- | --- | --- |
| one login, four sockets | `scripts/live/party.mjs` | four logins look like four sessions; the party shares one |
| publisher | `scripts/bot/publish.mjs` | each client already sees the fight; it posts its world instead of opening another socket to the game |
| relay | `scripts/live/relay.mjs` | merges the four views by entity id and serves them over SSE, no dependencies |
| gates | `scripts/bot/loop.mjs`, `loops/party/lib.mjs` | target allowlist, own-loot-only chests, keep-on-sell patterns, send/sell switches |
| hold role | `loops/party/hold.mjs` | joins the party and stands still - the first run on a real account |

The page is the local watch view from [adventureland-container](https://github.com/DionJones615/adventureland-container)
with one extra source (`?relay=1`), so nothing about the renderer is reimplemented here. Read
[examples/live-party/README.md](examples/live-party/README.md) before pointing it at an account you care about:
the live profile never sells, never gives items away, attacks only allowlisted monsters, and stops after a
bounded run.

## Env vars of the image

| variable | meaning |
| --- | --- |
| `AL_API` | account API base, e.g. `http://al-game:8090` |
| `AL_GAME_ADDRESS` | game socket `host:port` (**required in a container**: the server advertises its own `localhost`) |
| `BOT_LOOP` | loop module path, default `/app/loops/basic.mjs` |
| `AL_BOT_CHARACTER`, `AL_BOT_VENDOR_AT`, `AL_BOT_SAY`, `AL_BOT_TRANSPORT` | bot knobs |
| `AL_BOT_SECONDS` | run time; **0 or negative means "until SIGTERM"** (what the image sets) |
| `AL_BOT_EMAIL`, `AL_BOT_PASSWORD` | credentials (defaults are the container's dev account) |
| `AL_PARTY_LEADER`, `AL_PARTY_MEMBERS`, `AL_PARTY_MERCHANT` | party owner, the members to invite (comma list), and the merchant that receives loot |
| `AL_PARTY_ANCHOR`, `AL_PARTY_SELL_AT` | `x,y` farm point, and `x,y` of a merchant within 400 units |
| `AL_PARTY_SEND_AT`, `AL_PARTY_SELL_AT_FILL`, `AL_PARTY_HEAL_BELOW` | bag fractions for the handover and the sale, and the priest's heal threshold |
| `AL_PARTY_ROLE` | reported in the run's summary line, so four containers' runs can be told apart |

Mount `/app/reference/game-data` read-only to use a pinned copy of `data.js` instead of the one baked at build time.

## Tests

```sh
npm run test:unit                  # codec, entity deltas, queue, pathfinder, bot loop, vendor, party helpers, fixtures
npm run e2e:up                     # pull + start ghcr.io/dionjones615/adventureland-container:latest
npm run test:e2e                   # e2e against that image (9 tests)
npm run e2e:down
```

`e2e:up` wipes the clone's database (not its `node_modules`) so the fixtures from
[`test/e2e/fixtures/client-e2e.json`](test/e2e/fixtures/client-e2e.json) are what the assertions see. The e2e files
run serially (`--test-concurrency=1`) because they share those characters; override the image with `AL_IMAGE` — pin
a `:sha-<short>` tag for reproducible runs.

The suite covers: account API and fixtures, entering a fixture character (inventory, equipment, level, gold,
position), moving, routed pathfinding, chat, combat, the MessagePack transport, **two clients on one account at
once** — a JSON session and a MessagePack session driving two characters that see each other in the world and follow
each other's movement — and **a party of four** (three fighters plus a merchant) that forms one party, focus-fires,
heals, hands loot over and sells it.

`e2e:up` seeds two accounts: `dev@example.test` (the two single-character fixtures) and `party@example.test`
(the four party characters, from the same file the compose example mounts) — one account only has five character
slots.

Restart the stack (`e2e:down && e2e:up`) before re-running locally: the tests move characters, and a character left
online by an aborted run is a ghost whose server-side position no longer matches its document.

## Credits

Built on other people's work — see [`NOTICE`](NOTICE):

| source | what |
| --- | --- |
| [Adventure Land](https://adventure.land) / [kaansoral/adventureland_mongodb](https://github.com/kaansoral/adventureland_mongodb) | the game this client speaks to; game data fetched from adventure.land |
| [ALClient](https://github.com/kaansoral/ALClient) | the community client this one was **modelled on and read from** — no code copied, no licence claimed |
| [adventureland-container](https://github.com/DionJones615/adventureland-container) | the server image the e2e tests pull |

## Licence

MIT for the code here ([`LICENSE`](LICENSE)). The game itself is not included and is not MIT; it is cloned/used at
run time under its own terms (AdventureLandOnlyUse), with attribution and a crawlable link to
<https://adventure.land>. No game art, sounds or fonts are included.
