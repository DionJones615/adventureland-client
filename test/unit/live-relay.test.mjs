import assert from "node:assert/strict";
import test from "node:test";
import { mergeSources, startRelay } from "../../scripts/live/relay.mjs";

function source(name, at, extra = {}) {
	return {
		at,
		snapshot: Object.assign(
			{
				source: name,
				role: "fighter",
				self: { id: name, map: "main", x: 0, y: 0, hp: 100, max_hp: 200, items: [], isize: 42, level: 40 },
				entities: { players: [], monsters: [], npcs: [] },
				drops: [],
				party: [name],
				counters: { kills: 0 },
			},
			extra,
		),
	};
}

test("the union puts every publisher back into the player list, because a client omits itself", () => {
	const now = Date.now();
	const sources = new Map([
		["A", source("A", now, { entities: { players: [{ id: "B" }], monsters: [{ id: "m1", type: "goo" }], npcs: [] }, party: ["A", "B"] })],
		["B", source("B", now - 100, { entities: { players: [{ id: "A" }], monsters: [{ id: "m1", type: "goo" }, { id: "m2" }], npcs: [] } })],
	]);
	const frame = mergeSources(sources, { now });
	assert.deepEqual(frame.entities.players.map((entity) => entity.id).sort(), ["A", "B"]);
	assert.deepEqual(frame.entities.monsters.map((entity) => entity.id).sort(), ["m1", "m2"]);
	assert.deepEqual(frame.party.sort(), ["A", "B"]);
	assert.equal(frame.sources.length, 2);
});

test("the newest view of an entity wins, and a copied entity is not a merge of both", () => {
	const now = Date.now();
	const sources = new Map([
		["A", source("A", now - 100, { entities: { players: [], monsters: [{ id: "m1", hp: 10 }], npcs: [] } })],
		["B", source("B", now, { entities: { players: [], monsters: [{ id: "m1", hp: 4 }], npcs: [] } })],
	]);
	const frame = mergeSources(sources, { now });
	assert.equal(frame.entities.monsters.length, 1);
	assert.equal(frame.entities.monsters[0].hp, 4);
});

test("a source that stopped publishing disappears instead of leaving ghosts on the map", () => {
	const now = Date.now();
	const sources = new Map([
		["A", source("A", now, { entities: { players: [], monsters: [{ id: "m1" }], npcs: [] } })],
		["gone", source("gone", now - 60_000, { entities: { players: [], monsters: [{ id: "ghost" }], npcs: [] } })],
	]);
	const frame = mergeSources(sources, { now, staleMs: 10_000 });
	assert.deepEqual(frame.entities.monsters.map((entity) => entity.id), ["m1"]);
	assert.equal(frame.sources.length, 1);
	assert.deepEqual(frame.party, ["A"]);
});

test("the watch parameter chooses the camera, and falls back to the newest publisher", () => {
	const now = Date.now();
	const sources = new Map([
		["Dion6", source("Dion6", now - 500)],
		["Paion", source("Paion", now)],
	]);
	assert.equal(mergeSources(sources, { now, watch: "dion6" }).self.id, "Dion6");
	assert.equal(mergeSources(sources, { now, watch: "nobody" }).self.id, "Paion");
	assert.equal(mergeSources(new Map(), { now }).self, null);
});

test("bagFill and age travel with each source summary", () => {
	const now = Date.now();
	const items = [{ name: "a" }, null, { name: "b" }];
	const sources = new Map([["A", source("A", now - 2500, { self: { id: "A", map: "main", x: 1, y: 2, hp: 5, max_hp: 10, items, isize: 4, level: 7 } })]]);
	const summary = mergeSources(sources, { now }).sources[0];
	assert.equal(summary.name, "A");
	assert.equal(summary.bagFill, 0.5);
	assert.equal(summary.ageMs, 2500);
	assert.equal(summary.hp, 5);
});

test("the HTTP side accepts snapshots and streams merged frames over SSE", async () => {
	const relay = startRelay({ port: 0, rateMs: 30, log: () => {} });
	const base = await relay.started;
	const controller = new AbortController();
	try {
		const viewer = await fetch(base + "/events?watch=A", { signal: controller.signal });
		assert.equal(viewer.status, 200);
		const reader = viewer.body.getReader();
		const decoder = new TextDecoder();
		const post = await fetch(base + "/snapshot", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(source("A", Date.now()).snapshot),
		});
		assert.equal(post.status, 200);
		const health = await (await fetch(base + "/health")).json();
		assert.equal(health.ok, true);
		assert.equal(health.sources.length, 1);
		assert.equal(health.sources[0].name, "A");
		// The stream opens with whatever exists: the empty frame is sent before the first POST.
		// Keep reading until a frame actually carries the publisher.
		let seen = "";
		let frame = null;
		const deadline = Date.now() + 3000;
		while (!frame && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += decoder.decode(value, { stream: true });
			for (const chunk of seen.split("event: frame").slice(1)) {
				const body = chunk.slice(chunk.indexOf("data: ") + 6);
				const end = body.indexOf(String.fromCharCode(10, 10));
				if (end < 0) continue;
				try {
					const parsed = JSON.parse(body.slice(0, end));
					if (parsed && parsed.self) frame = parsed;
				} catch {
					/* a partial frame: the next read completes it */
				}
			}
		}
		assert.ok(frame, "no frame carried the publisher: " + seen.slice(0, 200));
		assert.equal(frame.self.id, "A");
		assert.equal(frame.party[0], "A");
		reader.cancel().catch(() => {});
	} finally {
		controller.abort();
		await relay.close();
	}
});
