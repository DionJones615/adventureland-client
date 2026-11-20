import assert from "node:assert/strict";
import test from "node:test";
import { openNearestChest } from "../../loops/party/lib.mjs";
import { focusTarget } from "../../scripts/bot/party.mjs";

const anchor = { x: 0, y: 0 };
const self = { id: "Tank", x: 0, y: 0, hp: 100, max_hp: 100 };

function monsters() {
	return [
		{ id: "m-goo", type: "goo", x: 30, y: 0, hp: 100, max_hp: 100 },
		{ id: "m-snake", type: "snake", x: 10, y: 0, hp: 500, max_hp: 500 },
	];
}

test("without an allowlist the party hits whatever is closest, as before", () => {
	assert.equal(focusTarget({ monsters: monsters(), anchor, self }).id, "m-snake");
	assert.equal(focusTarget({ monsters: monsters(), anchor, self, allowed: [] }).id, "m-snake");
});

test("an allowlist keeps the party off monsters nobody vetted", () => {
	assert.equal(focusTarget({ monsters: monsters(), anchor, self, allowed: ["goo"] }).id, "m-goo");
	assert.equal(focusTarget({ monsters: monsters(), anchor, self, allowed: ["SNAKE"] }).id, "m-snake");
	assert.equal(focusTarget({ monsters: monsters(), anchor, self, allowed: ["crab"] }), null);
});

function fakeClient() {
	const opened = [];
	const client = {
		world: {
			self,
			drops: new Map([["d1", { id: "d1", x: 20, y: 20 }]]),
		},
		walkTo: async () => {},
		openChest: async (id) => {
			opened.push(id);
			return { items: [], gold: 0 };
		},
	};
	return { client, opened };
}

test("own-loot mode refuses a pile that did not follow one of our kills", async () => {
	const { client, opened } = fakeClient();
	const counters = { chests: 0, failures: 0 };
	const state = { killTimes: [] };
	const result = await openNearestChest(client, { counters, log: () => {}, ownLoot: true, state });
	assert.equal(result, false);
	assert.deepEqual(opened, [], "nothing was opened");
	assert.equal(client.world.drops.size, 1, "and the pile is still there for whoever owns it");
});

test("a pile that followed our kill is ours to open", async () => {
	const { client, opened } = fakeClient();
	const counters = { chests: 0, failures: 0 };
	const state = { killTimes: [Date.now() - 1000] };
	const result = await openNearestChest(client, { counters, log: () => {}, ownLoot: true, state });
	assert.equal(result, true);
	assert.deepEqual(opened, ["d1"]);
	assert.equal(counters.chests, 1);
});

test("a kill older than the window no longer claims a pile", async () => {
	const { client, opened } = fakeClient();
	const counters = { chests: 0, failures: 0 };
	const state = { killTimes: [Date.now() - 60_000] };
	assert.equal(await openNearestChest(client, { counters, log: () => {}, ownLoot: true, state }), false);
	assert.deepEqual(opened, []);
});

test("without own-loot mode the old behaviour is untouched", async () => {
	const { client, opened } = fakeClient();
	const counters = { chests: 0, failures: 0 };
	assert.equal(await openNearestChest(client, { counters, log: () => {} }), true);
	assert.deepEqual(opened, ["d1"]);
});
