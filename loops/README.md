# Loops

A **loop** decides what the bot does; `scripts/bot.mjs` does everything else (login, account and
character bootstrap, socket, action execution, counters, the summary line). Loops are ordinary ES
modules, imported by path, so you can mount your own into the container instead of rebuilding it:

```sh
docker run --rm --network al \
  -e AL_API=http://al-game:8090 -e AL_GAME_ADDRESS=al-game:7192 \
  -e AL_BOT_CHARACTER=E2EMage -e AL_BOT_SECONDS=120 \
  -v "$PWD/my-loops:/loops:ro,z" -e BOT_LOOP=/loops/aggressive.mjs \
  ghcr.io/dionjones615/adventureland-client:latest
```

The mount point is yours to choose — `/loops`, `/app/loops`, anything absolute. `BOT_LOOP` (or
`--loop`) is the only thing that has to agree with it. Files next to your loop can be imported with
relative paths, so a strategy can be a directory rather than a single file.

## The contract

A loop must export **exactly one** of these; the runner validates it at startup and fails loudly
with the offending path if neither is present.

### `decide(state)` — pure strategy (recommended)

Called on every tick (~300 ms). Return one action; the runner executes it and calls you again.

```js
export function decide({ self, monsters, drops, anchor, step, now, nextSayAt, attackReadyAt, focus, avoid, config }) {
	if (!self.monsters) {
	}
	const nearest = monsters
		.filter((monster) => monster && typeof monster.x === "number" && !avoid.has(String(monster.id)))
		.sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y))[0];
	if (nearest && Math.hypot(nearest.x - self.x, nearest.y - self.y) <= config.attackRange) {
		return { type: "attack", id: nearest.id, distance: Math.round(Math.hypot(nearest.x - self.x, nearest.y - self.y)) };
	}
	return { type: "patrol", target: { x: Math.round(self.x + 60), y: Math.round(self.y) } };
}
```

| state | meaning |
| --- | --- |
| `self` | your character entity: `x`, `y`, `hp`, `mp`, `max_hp`, `max_mp`, `map`, `items`, `slots`, `frequency`, `range`, `rip` |
| `monsters` | entities in view, each with `id`, `x`, `y`, `hp`, `type` |
| `drops` | loot piles the server reported, `{ id, x, y }` |
| `anchor`, `step` | patrol anchor (moves with you when you drift 600+ units) and a monotonically increasing counter |
| `now`, `nextSayAt` | clock, and when the runner would next chat |
| `attackReadyAt`, `focus` | attack cooldown deadline and the current target id |
| `avoid` | `Set` of monster ids the runner gave up on |
| `config` | `attackRange`, `sayText`, `vendorAt`, … |

| action the runner understands | effect |
| --- | --- |
| `{ type: "respawn" }` | respawn after death |
| `{ type: "potion", item: "hp" }` / `{ type: "mana", item: "mp" }` | tap the regen skill (4 s server cooldown) |
| `{ type: "say", text }` | chat, rate-limited by the runner |
| `{ type: "loot", drop }` | walk over a drop |
| `{ type: "chase", id, target }` | walk towards a monster |
| `{ type: "attack", id }` | attack (the runner paces it to the character frequency) |
| `{ type: "patrol", target }` | walk a patrol step |
| `{ type: "vendor", items }` | sell the given `{ num, quantity }` entries, walking to a merchant if the server says `distance` |
| `{ type: "idle", until }` | wait out the attack cooldown |

### `run(context)` — full control

The runner hands over and waits. Use this when the decision model does not fit the table above.

```js
export async function run({ client, log, counters, sleep, config, args, deadline, shouldStop }) {
	while (!shouldStop()) {
		const self = client.world.self;
		if (self) log("at " + Math.round(self.x) + "," + Math.round(self.y) + " hp " + self.hp);
		await sleep(1000);
	}
}
```

`client` is the full protocol client (`world`, `move`, `attack`, `say`, `use`, `walkTo`, `sell`, events…),
`counters` is the summary object, `shouldStop()` honours `--seconds` and SIGINT/SIGTERM.

## Writing one

```sh
mkdir my-loops && cp loops/basic.mjs my-loops/mine.mjs   # start from the example
node scripts/bot.mjs --character Devmage --loop ./my-loops/mine.mjs --seconds 30
```

Keep it pure where you can: a `decide` loop is trivial to unit test (see
`test/unit/loop-contract.test.mjs` and `test/unit/bot-loop.test.mjs`).
