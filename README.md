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

## Env vars of the image

| variable | meaning |
| --- | --- |
| `AL_API` | account API base, e.g. `http://al-game:8090` |
| `AL_GAME_ADDRESS` | game socket `host:port` (**required in a container**: the server advertises its own `localhost`) |
| `BOT_LOOP` | loop module path, default `/app/loops/basic.mjs` |
| `AL_BOT_CHARACTER`, `AL_BOT_SECONDS`, `AL_BOT_VENDOR_AT`, `AL_BOT_SAY`, `AL_BOT_TRANSPORT` | bot knobs |
| `AL_BOT_EMAIL`, `AL_BOT_PASSWORD` | credentials (defaults are the container's dev account) |

Mount `/app/reference/game-data` read-only to use a pinned copy of `data.js` instead of the one baked at build time.

## Tests

```sh
npm run test:unit                  # codec, entity deltas, queue, pathfinder, bot loop, vendor, loop contract
npm run e2e:up                     # pull + start ghcr.io/dionjones615/adventureland-container:latest
npm run test:e2e                   # e2e against that image (7 tests)
npm run e2e:down
```

`e2e:up` wipes the clone's database (not its `node_modules`) so the fixtures from
[`test/e2e/fixtures/client-e2e.json`](test/e2e/fixtures/client-e2e.json) are what the assertions see. Override the
image with `AL_IMAGE` — pin a `:sha-<short>` tag for reproducible runs.

The e2e suite covers: account API and fixtures, entering a fixture character (inventory, equipment, level, gold,
position), moving, routed pathfinding, chat, combat, and the MessagePack transport.

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
