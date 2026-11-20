import assert from "node:assert/strict";
import test from "node:test";

import { emptyCounters, partyConfig, resolveRunWindow } from "../../scripts/bot.mjs";

test("seconds=0 means run until SIGTERM, not exit on start", () => {
	// The image sets AL_BOT_SECONDS=0; a container that stops the instant it starts is a bug.
	assert.equal(resolveRunWindow(0), Infinity);
	assert.equal(resolveRunWindow(-5), Infinity);
	assert.equal(resolveRunWindow("0"), Infinity);
	assert.equal(resolveRunWindow(undefined), Infinity);
	assert.equal(resolveRunWindow("not a number"), Infinity);
});

test("a positive window is a plain millisecond budget", () => {
	assert.equal(resolveRunWindow(1), 1000);
	assert.equal(resolveRunWindow("90"), 90_000);
	assert.equal(resolveRunWindow(0.5), 500);
});

test("the counters cover what the party loops report", () => {
	const counters = emptyCounters();
	for (const key of ["attacks", "hits", "kills", "chests", "sent", "received", "heals", "buffs", "sold", "gold", "failures"]) {
		assert.equal(counters[key], 0, key + " starts at zero");
	}
	assert.notEqual(emptyCounters(), counters, "each run gets its own bag");
});

test("party settings come from env-style args without inventing values", () => {
	const config = partyConfig({
		role: "merchant",
		leader: "PartyTank",
		members: "PartyTank,PartyMage,PartyPriest,PartyMerch",
		partyMerchant: "PartyMerch",
		anchor: "-100,800",
		sellAt: "-193,680",
	});
	assert.deepEqual(config, {
		role: "merchant",
		leader: "PartyTank",
		members: ["PartyTank", "PartyMage", "PartyPriest", "PartyMerch"],
		merchant: "PartyMerch",
		anchor: { x: -100, y: 800 },
		sellAt: { x: -193, y: 680 },
		sendAt: null,
		sellAtFill: null,
		healBelow: null,
	});
	// A solo bot that never heard of a party still starts.
	const solo = partyConfig({});
	assert.deepEqual(solo, { role: null, leader: null, members: [], merchant: null, anchor: null, sellAt: null, sendAt: null, sellAtFill: null, healBelow: null });
});

test("a bad anchor is rejected at startup rather than at the merchant", () => {
	assert.throws(() => partyConfig({ anchor: "near the goos" }), /x,y/);
});
