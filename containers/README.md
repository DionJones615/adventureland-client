# The client image

`client.Dockerfile` builds the protocol client plus the bot runner. Loops are loaded by path, so a strategy is a
mount, not a rebuild.

```sh
docker build -f containers/client.Dockerfile -t ghcr.io/dionjones615/adventureland-client:local .
```

## What the entrypoint does

1. Waits for `AL_API` to accept a login (the game stack may still be starting).
2. Resolves the loop: `BOT_LOOP`, default `/app/loops/basic.mjs`. A missing loop fails immediately with the directory
   listed, because "silently ran the default" is the worst possible outcome for a mounted strategy.
3. Runs `node scripts/bot.mjs` with the env mapped to flags — including `AL_GAME_ADDRESS`, which becomes
   `--address`. That override matters: the server advertises its own `localhost:<port>`, which inside this container
   is this container.

## Mounts

| path | why |
| --- | --- |
| `/loops` (or any absolute path) | your loop scripts; `BOT_LOOP` must point at the file. Sibling files import normally |
| `/app/reference/game-data` | optional: a pinned `data.js` instead of the one fetched at build |

## Env

| variable | meaning |
| --- | --- |
| `AL_API` | account API base (`http://al-game:8090`) |
| `AL_GAME_ADDRESS` | game socket `host:port` — required inside a container |
| `BOT_LOOP` | loop module path |
| `AL_BOT_CHARACTER`, `AL_BOT_SECONDS`, `AL_BOT_VENDOR_AT`, `AL_BOT_SAY`, `AL_BOT_TRANSPORT` | bot knobs |
| `AL_BOT_EMAIL`, `AL_BOT_PASSWORD` | credentials |

## Pairing with the game container

```sh
docker network create al
docker run -d --network al --name al-game -p 8090:8090 -p 7192:7192 \
  -e DEFAULT_EMAIL=dev@example.test -e DEFAULT_PASSWORD=dev-password-123 \
  ghcr.io/dionjones615/adventureland-container:latest

docker run --rm --network al \
  -e AL_API=http://al-game:8090 -e AL_GAME_ADDRESS=al-game:7192 \
  -e AL_BOT_CHARACTER=Devmage -e AL_BOT_SECONDS=120 \
  -v "$PWD/my-loops:/loops:ro,z" -e BOT_LOOP=/loops/mine.mjs \
  ghcr.io/dionjones615/adventureland-client:latest
```
