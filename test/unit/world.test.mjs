import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "../../client/world.mjs";

test("entity deltas are rebuilt from the last full packet", () => {
	const world = new World();
	world.in = "main";
	world.applyEntities({ in: "main", type: "all", players: [], monsters: [{ id: "1", x: 10, y: 20, hp: 50, moving: false }] });
	assert.equal(world.monsters.get("1").x, 10);
	world.applyEntities({ in: "main", monsters: [{ id: "1", "~": [], x: 30, y: 40 }] });
	const monster = world.monsters.get("1");
	assert.equal(monster.x, 30);
	assert.equal(monster.y, 40);
	assert.equal(monster.hp, 50, "fields absent from the delta are inherited");
	world.applyEntities({ in: "main", monsters: [{ id: "1", "~": ["hp"], x: 30 }] });
	assert.equal(world.monsters.get("1").hp, undefined, "~ lists removed keys");
});

test("a delta without its base asks for a complete view instead of guessing", () => {
	const world = new World();
	world.in = "main";
	let missing = 0;
	world.on("missing-delta-base", () => missing++);
	world.applyEntities({ in: "main", monsters: [{ id: "99", "~": [], x: 1 }] });
	assert.equal(missing, 1);
	assert.equal(world.monsters.size, 0);
});

test("entities land in the right store even without a type field", () => {
	const world = new World();
	world.in = "main";
	world.applyEntities({
		in: "main",
		type: "all",
		players: [{ id: "Devmage", x: 0, y: 0 }, { id: "citizen22", npc: "citizen22" }],
		monsters: [{ id: "42", x: 1, y: 1 }],
	});
	assert.ok(world.players.has("Devmage"));
	assert.ok(world.npcs.has("citizen22"));
	assert.ok(world.monsters.has("42"));
	assert.equal(world.players.size, 1);
});

test("stale map payloads are ignored", () => {
	const world = new World();
	world.in = "main";
	world.applyEntities({ in: "level1", type: "all", monsters: [{ id: "5" }] });
	assert.equal(world.monsters.size, 0);
});

test("start adopts the character, player updates it, disappear removes it", () => {
	const world = new World();
	world.reset();
	let self = null;
	world.on("self", (entity) => (self = entity));
	world.handle("start", { id: "devmage", hp: 257, max_hp: 257, level: 1, map: "main", in: "main", x: -87, y: 673, entities: { in: "main", type: "all", monsters: [{ id: "1" }] } });
	assert.equal(world.self.id, "devmage");
	assert.equal(world.self.hp, 257);
	assert.equal(world.monsters.size, 1);
	world.handle("player", { id: "devmage", hp: 200 });
	assert.equal(world.self.hp, 200);
	assert.equal(self.hp, 200);
	world.handle("disappear", { id: "1" });
	assert.equal(world.monsters.size, 0);
});
