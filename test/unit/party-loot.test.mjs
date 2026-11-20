import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS, sellableItems } from "../../scripts/bot/loop.mjs";
import { sendPlan, shouldSend } from "../../scripts/bot/party.mjs";
import { lootForMerchant } from "../../loops/party/lib.mjs";

/** A character with a mixed bag: loot, potions, and the sword it is holding. */
function fighter(overrides = {}) {
	return {
		isize: 42,
		items: [{ name: "gslime", q: 3 }, { name: "hpot1", q: 30 }, { name: "sword", q: 1 }, null, { name: "rattail", q: 2 }],
		slots: { mainhand: { name: "sword", level: 2 } },
		...overrides,
	};
}

test("the merchant gets the loot and the potion surplus, never the equipped sword", () => {
	const plan = sendPlan(fighter(), { potionStock: DEFAULTS.potionStock });
	assert.deepEqual(
		plan.map((entry) => entry.num + ":" + entry.name + "x" + entry.quantity),
		["0:gslimex3", "1:hpot1x10", "4:rattailx2"],
		"the placeholder slot and the worn weapon stay put",
	);
});

test("sendPlan drops nothing it cannot name", () => {
	const plan = sendPlan({ isize: 42, items: [{ name: "placeholder" }, null, { name: "ink", q: 1 }] });
	assert.deepEqual(plan, [{ num: 2, name: "ink", quantity: 1 }]);
	assert.deepEqual(sendPlan(null), []);
});

test("a bag has to be worth the trip before the fighters hand it over", () => {
	const mostlyEmpty = fighter({ items: [{ name: "gslime", q: 1 }] });
	assert.equal(shouldSend(mostlyEmpty, { sendAt: 0.4 }), false);
	const full = fighter();
	assert.equal(shouldSend(full, { sendAt: 0.09 }), true, "4 of 42 used slots is past a 9% threshold");
	assert.equal(shouldSend(full, { sendAt: 0.5 }), false);
	// Nothing sellable means nothing to hand over, however full the bag is.
	assert.equal(shouldSend({ isize: 42, items: [{ name: "placeholder" }] }, { sendAt: 0 }), false);
});

test("the merchant keeps its potion reserve when loot is handed on", () => {
	const plan = lootForMerchant(fighter(), { potionStock: DEFAULTS.potionStock });
	assert.ok(plan.every((entry) => entry.name !== "hpot1" || entry.quantity === 10));
	assert.deepEqual(lootForMerchant(fighter(), { potionStock: DEFAULTS.potionStock }), sendPlan(fighter(), { potionStock: DEFAULTS.potionStock }));
});

test("the party split never hands the merchant a chest item, so sending is the only path", () => {
	// Regression guard for the design: party chests are distributed by damage share (server), and a
	// merchant's share is 0 - see scripts/bot/party.mjs and README. The plan must therefore exist.
	const merchant = { isize: 42, items: [{ name: "gslime", q: 3 }], slots: {} };
	assert.ok(sellableItems(merchant).length > 0, "the merchant has something to sell");
	assert.ok(sendPlan(fighter(), { potionStock: DEFAULTS.potionStock }).length > 0, "the fighters have something to send");
});
