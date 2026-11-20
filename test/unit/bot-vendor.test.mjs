import assert from "node:assert/strict";
import test from "node:test";

import { findMerchant, sellItems } from "../../scripts/bot/vendor.mjs";

/** A client stub: answers per slot, and records what was sent. */
function fakeClient(answers) {
	const sent = [];
	return {
		sent,
		world: { map: "main", npcs: new Map() },
		G: { maps: { main: {} } },
		async sell({ num, quantity }) {
			sent.push({ num, quantity });
			const answer = answers[num];
			if (!answer) return { success: true, gold: 10, cevent: "sell" };
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
}

test("sells every entry and adds up the gold", async () => {
	const client = fakeClient({ 0: { success: true, gold: 4 }, 1: { success: true, gold: 6 } });
	const result = await sellItems(client, [
		{ num: 0, name: "goo", quantity: 2 },
		{ num: 1, name: "ratfur", quantity: 1 },
	]);
	assert.deepEqual(result, { sold: 2, gold: 10, left: [] });
	assert.deepEqual(client.sent, [{ num: 0, quantity: 2 }, { num: 1, quantity: 1 }]);
});

test("keeps out-of-range entries for the trip to the merchant", async () => {
	const client = fakeClient({ 0: { response: "distance", failed: true }, 1: { success: true, gold: 3 } });
	const logs = [];
	const result = await sellItems(client, [
		{ num: 0, name: "goo", quantity: 1 },
		{ num: 1, name: "ratfur", quantity: 1 },
	], (line) => logs.push(line));
	assert.equal(result.sold, 1);
	assert.equal(result.gold, 3);
	assert.deepEqual(result.left, [{ num: 0, name: "goo", quantity: 1 }]);
	assert.match(logs.join(" "), /distance/);
});

test("a thrown error does not lose the rest of the bag", async () => {
	const client = fakeClient({ 0: new Error("timeout"), 1: { success: true, gold: 2 } });
	const result = await sellItems(client, [
		{ num: 0, name: "goo", quantity: 1 },
		{ num: 1, name: "ratfur", quantity: 1 },
	]);
	assert.equal(result.sold, 1);
	assert.equal(result.left.length, 1);
	assert.equal(result.left[0].num, 0);
});

test("findMerchant prefers the override, then map data, then merchant NPCs", () => {
	const client = fakeClient({});
	assert.deepEqual(findMerchant(client, { x: 1, y: 2 }), { x: 1, y: 2 });
	client.G.maps.main.merchants = [{ x: 5, y: 6 }];
	assert.deepEqual(findMerchant(client), { x: 5, y: 6 });
	delete client.G.maps.main.merchants;
	client.world.npcs.set("standmerchant", { id: "standmerchant", x: -193, y: 680 });
	assert.deepEqual(findMerchant(client), { x: -193, y: 680 });
	client.world.npcs.clear();
	assert.equal(findMerchant(client), null);
});
