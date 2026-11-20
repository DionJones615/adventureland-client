# Reference protocol client

A from-scratch client for Adventure Land's game socket, written to be read: every module documents the
server behaviour it depends on, and every one of those claims names the file that proves it.

It is **not** a bot, has no UI, and is not intended for the live game. It exists to exercise the
protocol against a local server (`npm run local:up`) and to make the protocol legible.

## Why the wire code is the way it is

| what the client must do | why |
| --- | --- |
| connect over Socket.IO v4, websocket transport only | the game never uses polling for the game socket |
| send `map_protocol=1&entity_delta=1&no_graphics=1` in the handshake query | all three change server behaviour, not just rendering |
| emit `loaded` then `auth` | `auth` is ignored unless the socket registered as an observer first |
| treat `start` as "in game", not `welcome` | `welcome` is the observer view; the character arrives as `start` |
| predict movement locally | `send_xy_updates` skips the receiving player: the server never echoes your own position |
| rebuild entity deltas from a stored base packet | with `entity_delta=1`, `entities` carries `~` deltas |
| ask for `send_updates` when a delta base is missing | otherwise an entity silently disappears from the view |

## Modules

| module | responsibility |
| --- | --- |
| `index.mjs` | public exports |
| `client.mjs` | `ALClient`: login, connect, enter, event fan-out, reconnect surface |
| `http.mjs` | `AccountApi`: `POST /api/<method>`, cookie jar, `infs[]` parsing |
| `transport/socket.mjs` | `socket.io-client` wrapper, one transport, explicit lifecycle |
| `transport/msgpack-parser.mjs` | Socket.IO v5 packet codec for the MessagePack endpoint |
| `world.mjs` | entity store, delta reconstruction, self adoption |
| `movement.mjs` | local movement prediction and `correction` handling |
| `queue.mjs` | rate-limited request queue, response correlation, timeouts |
| `actions.mjs` | `move`, `walkTo`, `attack`, `useSkill`, `say`, `use`, `equip`, `respawn`, `sendUpdates`, `stop` |
| `pathfinder.mjs` | A* over map wall segments (`x_lines`/`y_lines`), the same test the game uses |
| `game-data.mjs` | loads `G` from the corpus `data.js` snapshot |
| `errors.mjs` | `ClientError`, `ResponseError`, `TimeoutError`, `DisconnectedError` |

## Session sequence

```
POST /api/signup_or_login {email, password}        -> { user, auth } + "auth" cookie
POST /api/create_character {name, char, look}
POST /api/servers_and_characters {}                -> payload lives in infs[type=servers_and_characters]
   socket connect  (/socket.io/ or /socket.io-msgpack/)
   <- welcome  {region, name, version, map, in, x, y}
   -> loaded   {width, height, scale}
   -> auth     {user, character: "CH_...", auth, code_slot, width, height, scale, no_graphics}
   <- start    {the character: id, hp, max_hp, level, map, in, x, y, entities}
   <- entities / u / player / game_response / game_log / ...
```

`character` must be the document id (`CH_...`) from `servers_and_characters`; the server only prefixes
`CH_` when it is missing, so a display name becomes a character that does not exist (`no_character`).
Character names are limited to 12 characters and a restricted alphabet (`api.js is_name_allowed`).

## Usage

```js
import { ALClient } from "./client/index.mjs";

const client = new ALClient({ apiBaseUrl: "http://127.0.0.1:8090" });
await client.login({ email: "dev@example.test", password: "dev-password-123" });
await client.connect({ transport: "json" });          // or { transport: "msgpack" }
await client.enter("Devmage");

client.on("hit", (hit) => console.log("damage", hit.damage));
await client.walkTo({ x: 120, y: 700 });
await client.attack("42");
await client.say("hello");
```

## Watching a character

A headless character can still be observed: `servers_and_characters` exposes a `secret` while the
character is online, and a connection made with `?secret=<secret>&desktop=1` is attached to that player
(`node/server.js` `handshake.query.secret` -> `welcome.character`). [`scripts/watch.mjs`](../scripts/watch.mjs)
uses it for a text view; the browser's watch view uses the same handshake (`js/game.js observe_character()`).

```js
const characters = await client.characters();
const watched = characters.find((entry) => entry.name === "Devmage" && entry.secret);
await client.connect({ server, query: { secret: watched.secret, desktop: "1" } });
client.socket.emit("loaded", { width: 1000, height: 700, scale: 2 });
```

Entity packets carry destinations, not positions, so interpolate between updates (the game does the
same in `js/entity_animations.js`) or the view will look frozen while the character moves.

## Transports

Both endpoints carry the same events. The JSON endpoint takes socket.io's stock parser; the MessagePack
endpoint needs a matching parser from the first packet. Ours is written against
`reference/upstream/node/msgpack_parser.js` (positional tuples `[type]`, `[type, data]`,
`[type, id, data]`) and is diff-tested against the game's own browser bundle in
`test/unit/msgpack-parser.test.mjs`.

## Tests

```sh
npm run test:unit          # codec, entity deltas, queue, pathfinder (no server)
npm run test:integration   # boots a real local stack on ports 8190/7292/27217
```

The integration suite covers: observer welcome, entering the game, entity sync, attacking a monster
(asserting a `hit` with damage), `say` (`game_response` + `chat_log`), movement persisted across a
reconnect, and parity between the JSON and MessagePack transports.

## Deliberate limits

- No stat recalculation (`calculate_player_stats`), so `max_hp`/`max_mp` come from the server only.
- No inventory/equipment model, no party/trade, no CODE-slot execution, no UI, no auto-play loop.
- `walkTo` plans over wall segments only; moving entities are not treated as obstacles.
- Reconnection is exposed as events; automatic resumption is left to the caller.
