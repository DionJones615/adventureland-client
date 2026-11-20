import assert from "node:assert/strict";
import test from "node:test";
import { keepItem, sellableItems } from "../../scripts/bot/loop.mjs";

const self = {
	slots: { hand: { name: "sword" } },
	isize: 42,
	items: [
		{ name: "gslime", q: 3 },
		{ name: "hpot1", q: 30 },
		{ name: "sword", q: 1 },
		{ name: "coat", q: 1 },
		{ name: "locked_ring", q: 1, l: 1 },
		{ name: "blocked_ring", q: 1, b: 1 },
		{ name: "placeholder", q: 1 },
	],
};

test("the default list is unchanged: loot and potion surplus, never gear in a slot", () => {
	assert.deepEqual(sellableItems(self), [
		{ num: 0, name: "gslime", quantity: 3 },
		{ num: 1, name: "hpot1", quantity: 10 },
		{ num: 3, name: "coat", quantity: 1 },
	]);
});

test("locked and blocked items are skipped instead of being refused by the server", () => {
	const names = sellableItems(self).map((entry) => entry.name);
	assert.ok(!names.includes("locked_ring"));
	assert.ok(!names.includes("blocked_ring"));
});

test("keep patterns are exact names or * wildcards, case-insensitive", () => {
	assert.deepEqual(sellableItems(self, { keep: ["coat"] }).map((entry) => entry.name), ["gslime", "hpot1"]);
	assert.deepEqual(sellableItems(self, { keep: ["*pot*"] }).map((entry) => entry.name), ["gslime", "coat"]);
	assert.deepEqual(sellableItems(self, { keep: ["*"] }), [], "keep everything is a valid profile");
	assert.equal(keepItem("Coat", ["c*"]), true);
	assert.equal(keepItem("coat", ["gslime"]), false);
});

test("a pattern with regex characters is matched literally", () => {
	assert.equal(keepItem("a.b", ["a.b"]), true);
	assert.equal(keepItem("axb", ["a.b"]), false);
	assert.equal(keepItem("x(1)", ["x(1)"]), true);
});
