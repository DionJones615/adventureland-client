import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS, bestPotion, decide, inventoryFill, inventoryFull, isLowHp, isLowMp, nearestDrop, nearestMonster, patrolTarget, sellableItems } from "../../scripts/bot/loop.mjs";

const self = { id: "Devmage", x: 100, y: 100, hp: 1000, max_hp: 1000, items: [] };
const monster = (id, x, y) => ({ id, x, y });

test("waits without a character", () => {
	assert.deepEqual(decide({ self: null }), { type: "wait" });
});

test("respawns when dead, whatever else is around", () => {
	const hurt = { ...self, rip: true };
	const action = decide({ self: hurt, monsters: [monster("a", 110, 100)] });
	assert.equal(action.type, "respawn");
});

test("taps the health regen skill when hurt", () => {
	const hurt = { ...self, hp: 100 };
	const action = decide({ self: hurt, monsters: [monster("a", 110, 100)] });
	assert.deepEqual(action, { type: "potion", item: "hp" });
});

test("isLowHp respects the ratio and ignores missing stats", () => {
	assert.equal(isLowHp({ hp: 10, max_hp: 100 }), true);
	assert.equal(isLowHp({ hp: 90, max_hp: 100 }), false);
	assert.equal(isLowHp({}), false);
	assert.equal(isLowHp({ hp: 1, max_hp: 100 }, 0), false);
});

test("attacks the nearest monster in range and ignores distant or dead ones", () => {
	const near = monster("near", 130, 100);
	const farther = monster("far", 280, 100);
	const dead = { ...monster("dead", 110, 100), dead: true };
	const action = decide({ self, monsters: [farther, dead, near] });
	assert.equal(action.type, "attack");
	assert.equal(action.id, "near");
	assert.equal(action.distance, 30);
});

test("chases a monster that is close but out of reach", () => {
	const far = monster("far", 250, 100);
	const action = decide({ self, monsters: [far], config: { attackRange: 120 } });
	assert.equal(action.type, "chase");
	assert.equal(action.id, "far");
});

test("attacks once inside the configured range", () => {
	const near = monster("near", 80, 100);
	const action = decide({ self, monsters: [near], config: { attackRange: 120 } });
	assert.equal(action.type, "attack");
	assert.equal(action.distance, 20);
});

test("sticks with the focused target even when another is nearer", () => {
	const focused = monster("focused", 150, 100);
	const nearer = monster("nearer", 60, 100);
	const action = decide({ self, monsters: [nearer, focused], focus: "focused", config: { attackRange: 200 } });
	assert.equal(action.id, "focused");
});

test("falls back to the nearest monster when the focus is gone", () => {
	const nearer = monster("nearer", 60, 100);
	const action = decide({ self, monsters: [nearer], focus: "gone", config: { attackRange: 200 } });
	assert.equal(action.id, "nearer");
});

test("waits out the attack cooldown instead of swinging", () => {
	const near = monster("near", 80, 100);
	const action = decide({ self, monsters: [near], now: 1_000, attackReadyAt: 2_500, config: { attackRange: 120 } });
	assert.equal(action.type, "idle");
	assert.equal(action.until, 2_500);
});

test("attacks again once the cooldown has passed", () => {
	const near = monster("near", 80, 100);
	const action = decide({ self, monsters: [near], now: 3_000, attackReadyAt: 2_500, config: { attackRange: 120 } });
	assert.equal(action.type, "attack");
});

test("ignores monsters beyond the chase range", () => {
	const action = decide({ self, monsters: [monster("huge", 900, 900)], config: { chaseRange: 400 } });
	assert.equal(action.type, "patrol");
});
test("patrols when nothing is in range", () => {
	const action = decide({ self, monsters: [monster("far", 900, 900)] });
	assert.equal(action.type, "patrol");
	assert.ok(Number.isFinite(action.target.x) && Number.isFinite(action.target.y));
});

test("says something when the timer is due and nothing is in range", () => {
	const action = decide({ self, monsters: [], now: 5_000, nextSayAt: 4_000 });
	assert.deepEqual(action, { type: "say", text: DEFAULTS.sayText });
});

test("patrolTarget cycles the ring and stays within the radius", () => {
	const anchor = { x: 0, y: 0 };
	const first = patrolTarget(anchor, 0, 90);
	const ninth = patrolTarget(anchor, 8, 90);
	assert.deepEqual(first, ninth, "wraps after eight directions");
	for (let step = 0; step < 8; step++) {
		const target = patrolTarget(anchor, step, 90);
		assert.ok(Math.hypot(target.x, target.y) <= 90 * Math.SQRT2 + 1);
	}
});

test("reports how full the bag is", () => {
	const items = new Array(42).fill(null);
	items[0] = { name: "hpot0", q: 5 };
	items[1] = { name: "goo" };
	assert.equal(inventoryFill({ items, isize: 42 }), 2 / 42);
	assert.equal(inventoryFill({}), 0);
	assert.equal(inventoryFull({ items, isize: 42 }, 0.5), false);
});

test("asks to vendor once the bag is full", () => {
	const items = new Array(42).fill(null).map((_, index) => ({ name: "loot" + index }));
	const action = decide({ self: { ...self, items, isize: 42 }, monsters: [monster("a", 110, 100)] });
	assert.equal(action.type, "vendor");
	assert.equal(action.items.length, 42);
});

test("keeps potions and equipped gear out of the sale", () => {
	const items = [
		{ name: "hpot0", q: 10 },
		{ name: "mpot1", q: 3 },
		{ name: "goo", q: 4 },
		{ name: "placeholder" },
		null,
		{ name: "sword" },
	];
	const sold = sellableItems({ items, slots: { mainhand: { name: "sword" } } });
	assert.deepEqual(sold, [{ num: 2, name: "goo", quantity: 4 }]);
});

test("does not vendor a bag that holds only keepers", () => {
	const items = new Array(42).fill(null).map(() => ({ name: "hpot0", q: 5 }));
	const action = decide({ self: { ...self, items, isize: 42 }, monsters: [] });
	assert.notEqual(action.type, "vendor");
});

test("sells potion surplus above the stock, but never the last few", () => {
	const sold = sellableItems({ items: [{ name: "hpot0", q: 200 }, { name: "mpot0", q: 5 }] });
	assert.deepEqual(sold, [{ num: 0, name: "hpot0", quantity: 180 }]);
});
test("healing beats vendoring", () => {
	const items = new Array(42).fill(null).map((_, index) => ({ name: "loot" + index }));
	const action = decide({ self: { ...self, hp: 5, items, isize: 42 }, monsters: [] });
	assert.equal(action.type, "potion");
});
test("nearestDrop picks the closest pile in range", () => {
	const drops = [{ id: "a", x: 150, y: 100 }, { id: "b", x: 110, y: 100 }, { id: "c", x: 900, y: 900 }];
	const drop = nearestDrop(drops, self, 220);
	assert.equal(drop.id, "b");
	assert.equal(drop.distance, 10);
	assert.equal(nearestDrop([{ id: "x", x: 900, y: 900 }], self, 100), null);
});

test("loots a nearby pile before chasing a monster", () => {
	const action = decide({ self, monsters: [monster("m", 250, 100)], drops: [{ id: "d1", x: 130, y: 100 }] });
	assert.equal(action.type, "loot");
	assert.equal(action.drop.id, "d1");
});

test("does not loot when the bag is already full", () => {
	const items = new Array(42).fill(null).map((_, index) => ({ name: "loot" + index }));
	const action = decide({ self: { ...self, items, isize: 42 }, monsters: [], drops: [{ id: "d1", x: 130, y: 100 }] });
	assert.equal(action.type, "vendor");
});
test("nearestMonster returns null for an empty list or out of range", () => {
	assert.equal(nearestMonster([], self, 100), null);
	assert.equal(nearestMonster([monster("a", 900, 900)], self, 100), null);
});

test("bestPotion ignores unknown items and non-health potions", () => {
	assert.equal(bestPotion({ items: [{ name: "mpot1" }, { name: "sword" }] }), null);
	assert.equal(bestPotion({ items: [{ name: "hpot1" }] }), "hpot1");
	assert.equal(bestPotion({ items: [null, undefined, { name: "hpot0" }] }), "hpot0");
});
test("taps the mana regen skill when low on mp", () => {
	const lowMana = { ...self, mp: 10, max_mp: 100 };
	const action = decide({ self: lowMana, monsters: [monster("a", 110, 100)] });
	assert.deepEqual(action, { type: "mana", item: "mp" });
});

test("health takes priority over mana", () => {
	const both = { ...self, hp: 10, mp: 5 };
	assert.equal(decide({ self: both, monsters: [] }).type, "potion");
});

test("says something before fighting when the say timer is due", () => {
	const action = decide({ self, monsters: [monster("a", 110, 100)], now: 9_000, nextSayAt: 8_000 });
	assert.deepEqual(action, { type: "say", text: DEFAULTS.sayText });
});

test("skips monsters the runner has given up on", () => {
	const near = monster("near", 130, 100);
	const action = decide({ self, monsters: [near], avoid: new Set(["near"]) });
	assert.equal(action.type, "patrol");
});

test("isLowMp ignores a character with no mana pool", () => {
	assert.equal(isLowMp({ mp: 0, max_mp: 0 }), false);
	assert.equal(isLowMp({ mp: 2, max_mp: 710 }), true);
	assert.equal(isLowMp({ mp: 700, max_mp: 710 }), false);
});

test("bestPotion ranks by kind, not across kinds", () => {
	assert.equal(bestPotion({ items: [{ name: "mpot2" }, { name: "mpot0" }] }, "mpot"), "mpot2");
	assert.equal(bestPotion({ items: [{ name: "mpot2" }] }, "hpot"), null);
});
