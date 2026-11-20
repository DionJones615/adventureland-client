import assert from "node:assert/strict";
import test from "node:test";

import { World } from "../../client/world.mjs";

test("a party_update becomes the roster, with the per-member info the server sends", () => {
	const world = new World();
	const handled = world.handle("party_update", { list: ["PartyTank", "PartyMage"], party: { PartyTank: { level: 40, share: 0.6 } } });
	assert.equal(handled, true, "the world consumes the event");
	assert.deepEqual(world.party.list, ["PartyTank", "PartyMage"]);
	assert.equal(world.party.info.PartyTank.level, 40);
});

test("an empty party_update clears the roster (leave, kick, disband)", () => {
	const world = new World();
	world.handle("party_update", { list: ["PartyTank"] });
	world.handle("party_update", {});
	assert.equal(world.party, null, "a stale roster is worse than none: it makes a loop invite ghosts");
});

test("a roster with no names is treated as no party", () => {
	const world = new World();
	world.handle("party_update", { list: [] });
	assert.equal(world.party, null);
	world.handle("party_update", { list: ["PartyTank", 42] });
	assert.deepEqual(world.party.list, ["PartyTank"], "non-string entries are dropped");
});

test("disconnecting forgets the party", () => {
	const world = new World();
	world.handle("party_update", { list: ["PartyTank"] });
	world.reset();
	assert.equal(world.party, null);
});
