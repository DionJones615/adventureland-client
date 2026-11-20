import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildSnapshot, createPublisher } from "../../scripts/bot/publish.mjs";

function fakeClient() {
	const client = new EventEmitter();
	client.character = "Dion6";
	client.world = {
		map: "main",
		self: { id: "Dion6", hp: 700, max_hp: 900, mp: 120, max_mp: 200, x: 10, y: 20, items: [{ name: "hpot1", q: 5 }], slots: { hand: { name: "sword" } }, isize: 42, level: 67, ctype: "warrior" },
		players: new Map([["Dion6", {}], ["Maion", { id: "Maion", hp: 5 }]]),
		monsters: new Map([["m1", { id: "m1", type: "goo", hp: 100 }]]),
		npcs: new Map([["standmerchant", { id: "standmerchant" }]]),
		drops: new Map([["d1", { id: "d1", x: 1, y: 2, items: [1, 2] }]]),
		party: { list: ["Dion6", "Maion"] },
	};
	return client;
}

test("a snapshot carries the character, its surroundings and never itself in players", () => {
	const snapshot = buildSnapshot(fakeClient(), { role: "leader", counters: { kills: 3 } });
	assert.equal(snapshot.source, "Dion6");
	assert.equal(snapshot.role, "leader");
	assert.equal(snapshot.self.id, "Dion6");
	assert.equal(snapshot.self.level, 67);
	assert.equal(snapshot.self.gold, 0);
	assert.equal(snapshot.self.items.length, 1);
	assert.deepEqual(snapshot.players || [], []);
	assert.deepEqual(snapshot.entities.players.map((entity) => entity.id), ["Maion"], "the publisher never lists itself");
	assert.deepEqual(snapshot.entities.monsters.map((entity) => entity.id), ["m1"]);
	assert.deepEqual(snapshot.drops, [{ id: "d1", x: 1, y: 2, items: 2 }]);
	assert.deepEqual(snapshot.party, ["Dion6", "Maion"]);
	assert.equal(snapshot.counters.kills, 3);
});

test("events are drained once and capped, so a long fight cannot grow the frame", () => {
	const client = fakeClient();
	const sent = [];
	const publisher = createPublisher(client, {
		url: "http://127.0.0.1:7899",
		getCounters: () => ({}),
		fetchImpl: async (url, options) => {
			sent.push({ url, body: JSON.parse(options.body) });
			return { ok: true, status: 200 };
		},
	});
	assert.equal(publisher.endpoint, "http://127.0.0.1:7899/snapshot");
	client.emit("event", "hit", { hid: "Dion6", id: "m1", damage: 12 });
	client.emit("event", "not_interesting", { huge: "x".repeat(100) });
	publisher.flush();
	return new Promise((resolve) =>
		setTimeout(() => {
			assert.equal(sent.length, 1);
			assert.equal(sent[0].body.events.length, 1);
			assert.equal(sent[0].body.events[0].name, "hit");
			resolve();
		}, 50),
	);
});

test("a relay that is not running never throws into a loop", async () => {
	const client = fakeClient();
	let attempts = 0;
	const publisher = createPublisher(client, {
		url: "http://127.0.0.1:7899",
		fetchImpl: async () => {
			attempts++;
			throw new Error("connect ECONNREFUSED");
		},
	});
	publisher.flush();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.ok(attempts >= 1);
	assert.equal(publisher.stats.failed, 1);
	assert.match(publisher.stats.lastError, /ECONNREFUSED/);
});

test("stop() ends the timer and start() is idempotent", async () => {
	const client = fakeClient();
	let posts = 0;
	const publisher = createPublisher(client, {
		url: "http://127.0.0.1:7899/",
		intervalMs: 10,
		fetchImpl: async () => {
			posts++;
			return { ok: true };
		},
	});
	publisher.start();
	publisher.start();
	// The publisher never runs faster than 50ms, whatever the caller asks for.
	await new Promise((resolve) => setTimeout(resolve, 200));
	const during = posts;
	assert.ok(during >= 3, "kept publishing, got " + during);
	publisher.stop();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(posts, during, "nothing is posted after stop()");
});

test("a snapshot without a character is not published", async () => {
	const client = fakeClient();
	client.world.self = null;
	let posts = 0;
	const publisher = createPublisher(client, {
		url: "http://127.0.0.1:7899",
		fetchImpl: async () => {
			posts++;
			return { ok: true };
		},
	});
	publisher.flush();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(posts, 0);
});
