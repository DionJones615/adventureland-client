import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ensureParty, maintainParty, partyComplete, partyRoster } from "../../scripts/bot/party.mjs";

/** A client stub that records party packets and can play the server's roster updates. */
class FakeClient extends EventEmitter {
	constructor({ id = "PartyTank", roster = null, party = null } = {}) {
		super();
		this.character = id;
		this.calls = [];
		this.world = { self: { id, party }, party: roster ? { list: roster, info: {} } : null, players: new Map() };
	}
	async party(payload) {
		this.calls.push(payload);
		return { success: true, place: "party" };
	}
	setRoster(list) {
		this.world.party = list && list.length ? { list, info: {} } : null;
		this.emit("party_update", this.world.party);
	}
	/** What was sent, deduplicated: ensureParty legitimately retries the same packets. */
	unique() {
		return [...new Set(this.calls.map((call) => call.event + ":" + (call.name || "")))];
	}
}

const shortSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)));
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a leader invites every missing member", async () => {
	const client = new FakeClient({ id: "PartyTank" });
	const log = [];
	const joined = await ensureParty({
		client,
		leader: "PartyTank",
		members: ["PartyTank", "PartyMage", "PartyPriest", "PartyMerch"],
		log: (line) => log.push(line),
		sleep: shortSleep,
		timeoutMs: 5,
		retryMs: 1,
	});
	assert.equal(joined, false, "the roster never arrives, so this is not a success");
	assert.deepEqual(client.unique(), ["invite:PartyMage", "invite:PartyPriest", "invite:PartyMerch"], "never invites itself");
	assert.match(log.join(" "), /party still incomplete/);
});

test("a member requests the leader and accepts its invite", async () => {
	const client = new FakeClient({ id: "PartyMage" });
	await ensureParty({ client, leader: "PartyTank", members: ["PartyTank", "PartyMage"], sleep: shortSleep, timeoutMs: 5, retryMs: 1 });
	assert.deepEqual(client.unique(), ["request:PartyTank"]);

	// The handshake watcher outlives ensureParty: a leader that stops listening stops growing.
	client.calls.length = 0;
	client.emit("invite", { name: "PartyTank" });
	await flush();
	assert.deepEqual(client.calls, [{ event: "accept", name: "PartyTank" }]);

	// An invite from someone else is not our business.
	client.calls.length = 0;
	client.emit("invite", { name: "SomebodyElse" });
	await flush();
	assert.deepEqual(client.calls, []);
});

test("a leader answers join requests with raccept, and ignores its own party", async () => {
	const client = new FakeClient({ id: "PartyTank" });
	await ensureParty({ client, leader: "PartyTank", members: ["PartyTank"], sleep: shortSleep, timeoutMs: 5, retryMs: 1 });
	client.calls.length = 0;
	client.emit("request", { name: "PartyPriest" });
	await flush();
	assert.deepEqual(client.calls, [{ event: "raccept", name: "PartyPriest" }]);

	// Already a member: no answer, or the server would see a duplicate.
	client.setRoster(["PartyTank", "PartyPriest"]);
	client.calls.length = 0;
	client.emit("request", { name: "PartyPriest" });
	await flush();
	assert.deepEqual(client.calls, []);
});

test("a party left over from an aborted run is left before rejoining", async () => {
	const client = new FakeClient({ id: "PartyPriest", party: "StaleParty" });
	await ensureParty({ client, leader: "PartyTank", members: ["PartyTank"], sleep: shortSleep, timeoutMs: 20, retryMs: 1 });
	assert.equal(client.calls[0].event, "leave", "leave first: the server will not move us otherwise");
	assert.ok(client.calls.some((call) => call.event === "request"), "and then ask to join");
});

test("an already complete party costs no packets", async () => {
	const client = new FakeClient({ id: "PartyTank", roster: ["PartyTank", "PartyMage"] });
	const joined = await ensureParty({ client, leader: "PartyTank", members: ["PartyTank", "PartyMage"], sleep: shortSleep });
	assert.equal(joined, true);
	assert.deepEqual(client.calls, []);
});

test("maintainParty is a single cheap pass", async () => {
	const client = new FakeClient({ id: "PartyTank", roster: ["PartyTank"] });
	assert.equal(await maintainParty({ client, leader: "PartyTank", members: ["PartyTank", "PartyMage"] }), false);
	assert.deepEqual(client.calls, [{ event: "invite", name: "PartyMage" }]);
	client.setRoster(["PartyTank", "PartyMage"]);
	assert.equal(await maintainParty({ client, leader: "PartyTank", members: ["PartyTank", "PartyMage"] }), true);
	assert.deepEqual(partyRoster(client), ["PartyTank", "PartyMage"]);
	assert.equal(partyComplete(client, ["partytank", "partymage"]), true, "names compare case-insensitively");
});

test("shouldStop ends the wait without throwing", async () => {
	const client = new FakeClient({ id: "PartyMage" });
	const result = await ensureParty({ client, leader: "PartyTank", members: ["PartyTank"], sleep: shortSleep, shouldStop: () => true });
	assert.equal(result, false);
	assert.deepEqual(client.calls, []);
});
