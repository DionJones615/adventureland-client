# The client image: the protocol client plus the bot runner. Loops are loaded by path, so you can
# mount your own instead of rebuilding:
#
#   docker run --rm --network al \
#     -e AL_API=http://al-game:8090 -e AL_GAME_ADDRESS=al-game:7192 \
#     -e AL_BOT_CHARACTER=E2EMage -e AL_BOT_SECONDS=120 \
#     -v "$PWD/my-loops:/loops:ro,z" -e BOT_LOOP=/loops/aggressive.mjs \
#     ghcr.io/dionjones615/adventureland-client:latest

FROM docker.io/library/node:22-bookworm-slim

LABEL org.opencontainers.image.title="adventureland-client" \
      org.opencontainers.image.description="Adventure Land protocol client and bot runner, with mountable loop scripts" \
      org.opencontainers.image.source="https://github.com/DionJones615/adventureland-client" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY client ./client
COPY scripts ./scripts
COPY loops ./loops
COPY containers ./containers

# Game data for pathfinding and attack ranges. Fetched from adventure.land at build time so the
# image is self-contained; mount over /app/reference/game-data to use a pinned local copy instead.
RUN npm run fetch-data

ENV AL_API=http://127.0.0.1:8090 \
    BOT_LOOP=/app/loops/basic.mjs \
    AL_BOT_CHARACTER=Devmage \
    AL_BOT_SECONDS=0 \
    AL_BOT_SAY=1

ENTRYPOINT ["/bin/bash", "/app/containers/entrypoint-client.sh"]
