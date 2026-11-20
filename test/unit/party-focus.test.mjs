import assert from "node:assert/strict";
import test from "node:test";

import { chestsNearby, focusTarget, lowestHpMember, parseAnchor, parsePartyChat } from "../../scripts/bot/party.mjs";

const at = (id, x, y, hp = 100) => ({ id, x, y, hp, max_hp: 100 });

test("every member of the party picks the same monster", () => {
	const monsters = [at("m1", 10, 0, 80), at("m2", 100, 0, 40), at("m3", -20, 0, 80)];
	const anchor = { x: 0, y: 0 };
	// Same world, different parties of observers: the answer must not depend on who asks. The monster
	// closest to the anchor wins, because anchor distance is what every member sees identically.
	const fromTank = focusTarget({ monsters, anchor, self: { id: "PartyTank", x: 0, y: 10 } });
	const fromMage = focusTarget({ monsters, anchor, self: { id: "PartyMage", x: 30, y: -40 } });
	const fromPriest = focusTarget({ monsters, anchor, self: { id: "PartyPriest", x: -5, y: 5 } });
	assert.deepEqual([fromTank.id, fromMage.id, fromPriest.id], ["m1", "m1", "m1"]);
});

test("a nearer target beats a more wounded one (hp is the tie-break, not the rule)", () => {
	const anchor = { x: 0, y: 0 };
	const self = { id: "me", x: 0, y: 0 };
	// 5 units away and healthy vs 200 units away and nearly dead: the group takes the close one.
	const monsters = [at("close", 5, 0, 100), at("far", 200, 0, 5)];
	assert.equal(focusTarget({ monsters, anchor, self }).id, "close");
	// Same bucket, so hp decides.
	const sameBucket = [at("hurt", 8, 0, 20), at("fresh", 9, 0, 90)];
	assert.equal(focusTarget({ monsters: sameBucket, anchor, self }).id, "hurt");
});

test("the lowest hp target wins, and the id breaks a tie", () => {
	const anchor = { x: 0, y: 0 };
	const self = { id: "me", x: 0, y: 0 };
	assert.equal(focusTarget({ monsters: [at("b", 5, 0, 50), at("a", 5, 0, 50), at("c", 5, 0, 90)], anchor, self }).id, "a");
	assert.equal(focusTarget({ monsters: [at("a", 5, 0, 50), at("b", 5, 0, 30)], anchor, self }).id, "b");
});

test("dead, unreachable and avoided monsters are skipped", () => {
	const anchor = { x: 0, y: 0 };
	const self = { id: "me", x: 0, y: 0 };
	const monsters = [
		{ id: "dead", x: 1, y: 0, hp: 1, dead: true },
		{ id: "rip", x: 1, y: 0, hp: 1, rip: true },
		{ id: "far", x: 5000, y: 0, hp: 1 },
		at("ok", 10, 0, 90),
	];
	assert.equal(focusTarget({ monsters, anchor, self }).id, "ok");
	assert.equal(focusTarget({ monsters, anchor, self, avoid: new Set(["ok"]) }), null);
	assert.equal(focusTarget({ monsters, anchor, self, maxDistance: 5 }), null);
	assert.equal(focusTarget({ monsters, anchor: null, self }), null);
});

test("a monster without hp still counts (deltas can arrive without it)", () => {
	const found = focusTarget({ monsters: [{ id: "x", x: 1, y: 1 }], anchor: { x: 0, y: 0 }, self: { id: "me" } });
	assert.equal(found.id, "x");
});

test("the weakest party member is the one the priest heals", () => {
	const players = new Map([
		["PartyTank", { id: "PartyTank", x: 10, y: 0, hp: 300, max_hp: 500 }],
		["PartyMage", { id: "PartyMage", x: 20, y: 0, hp: 60, max_hp: 300 }],
		["PartyPriest", { id: "PartyPriest", x: 0, y: 0, hp: 300, max_hp: 300 }],
	]);
	const client = { world: { players, self: { id: "PartyPriest", x: 0, y: 0 } } };
	const lowest = lowestHpMember({ client, members: ["PartyTank", "PartyMage", "PartyPriest"] });
	assert.equal(lowest.name, "PartyMage");
	assert.equal(lowest.ratio, 0.2);
	// Out of view (or out of range) means no heal rather than a blind one.
	assert.equal(lowestHpMember({ client, members: ["PartyMage"], maxDistance: 1 }), null);
});

test("chests are listed nearest first and limited by range", () => {
	const drops = [
		{ id: "far", x: 300, y: 0 },
		{ id: "near", x: 5, y: 0 },
		{ id: "out", x: 900, y: 900 },
	];
	const found = chestsNearby({ drops, self: { x: 0, y: 0 }, range: 400 });
	assert.deepEqual(found.map((drop) => drop.id), ["near", "far"]);
});

test("anchors parse from 'x,y' and malformed ones fail loudly", () => {
	assert.deepEqual(parseAnchor("-100,800"), { x: -100, y: 800 });
	assert.deepEqual(parseAnchor({ x: 1, y: 2 }), { x: 1, y: 2 });
	assert.equal(parseAnchor(""), null);
	assert.throws(() => parseAnchor("near the goos"), /x,y/);
});

test("party chat packets keep the speaker and the text", () => {
	assert.deepEqual(parsePartyChat({ owner: "PartyTank", message: "focus goo" }), { from: "PartyTank", message: "focus goo", id: null });
	assert.equal(parsePartyChat({}), null);
	assert.equal(parsePartyChat(null), null);
});
