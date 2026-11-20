import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const partyFixture = read("../../examples/party/fixtures/party.json");
const e2eFixture = read("../e2e/fixtures/client-e2e.json");

const CLASSES = ["warrior", "mage", "priest", "merchant"];
const NAME = /^[A-Za-z0-9]{4,12}$/;
const anchor = { x: -100, y: 800 };

test("the party example ships four characters, one per role", () => {
	const characters = partyFixture.characters;
	assert.equal(characters.length, 4);
	assert.deepEqual(characters.map((character) => character.type).sort(), [...CLASSES].sort());
	for (const character of characters) {
		assert.match(character.name, NAME, character.name + " is a legal character name (4-12 alphanumerics)");
		assert.equal(character.map, "main");
		const distance = Math.hypot(character.x - anchor.x, character.y - anchor.y);
		assert.ok(distance <= 200, character.name + " stands within 200 units of the party anchor, got " + Math.round(distance));
	}
});

test("the classes can actually do their party job at their seeded level", () => {
	const byType = Object.fromEntries(partyFixture.characters.map((character) => [character.type, character]));
	assert.ok(byType.priest.skills.partyheal, "the priest knows partyheal");
	assert.ok(byType.priest.skills.heal, "and the single-target heal");
	assert.ok(byType.merchant.skills.mluck, "the merchant knows Merchant's Luck");
	assert.ok(byType.merchant.level >= 40, "mluck requires level 40");
	assert.ok(byType.warrior.inventory.length >= 17, "the tank starts full enough that the handover fires on the first ticks");
	assert.ok(byType.merchant.inventory.length >= 1, "the merchant starts with something to sell");
});

test("the party has its own account: one account only holds five characters", () => {
	assert.notEqual(partyFixture.account.email, e2eFixture.account.email, "a separate account, because 4 party + 2 e2e characters exceed the 5 slots");
	assert.equal(partyFixture.characters.length, 4);
	assert.equal(e2eFixture.characters.length, 2);
	const names = [...partyFixture.characters, ...e2eFixture.characters].map((character) => character.name.toLowerCase());
	assert.equal(new Set(names).size, names.length, "character names are unique");
});

test("the example composes the four shipped loops against that fixture", () => {
	const compose = readFileSync(new URL("../../examples/party/docker-compose.yml", import.meta.url), "utf8");
	assert.match(compose, /SEED_FIXTURES: \/app\/fixtures\/party\.json/);
	for (const loop of ["leader", "fighter", "priest", "merchant"]) {
		assert.match(compose, new RegExp("BOT_LOOP: /app/loops/party/" + loop + "\\.mjs"), loop + " is wired into the example");
		assert.ok(readFileSync(new URL("../../loops/party/" + loop + ".mjs", import.meta.url), "utf8").length > 100, loop + ".mjs exists");
	}
	// The e2e harness seeds the same fixture into a second account, so the test and the example agree.
	const harness = readFileSync(new URL("../../scripts/e2e/container.mjs", import.meta.url), "utf8");
	assert.match(harness, /party-fixtures/);
	assert.match(harness, /party\.json/);
});
