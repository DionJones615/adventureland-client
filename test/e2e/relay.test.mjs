// The relay e2e: two real clients, their worlds published over HTTP, one merged frame on the wire.
//
// The unit tests prove the merge in isolation; this proves the whole local loop against a real
// stack - login, two game sockets, the publisher's POST, the relay's SSE, and a frame that carries
// both characters. It is the same pipeline a live party uses, with characters that live in a
// throwaway database.
//
// Start from a clean stack (npm run e2e:up): a character left online is a ghost whose server-side
// position no longer matches its document.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ALClient } from "../../client/index.mjs";
import { bootClient, emptyCounters } from "../../scripts/bot/runner.mjs";
import { createPublisher } from "../../scripts/bot/publish.mjs";
import { startRelay } from "../../scripts/live/relay.mjs";

let fileEnv = {};
try {
	fileEnv = JSON.parse(readFileSync(new URL("../../.e2e-env.json", import.meta.url), "utf8"));
} catch {}

const API = process.env.AL_E2E_API || fileEnv.api || "http://127.0.0.1:18090";
const ADDRESS = process.env.AL_E2E_ADDRESS || fileEnv.address || null;
const EMAIL = process.env.AL_E2E_PARTY_EMAIL || (fileEnv.party && fileEnv.party.email) || "party@example.test";
const PASSWORD = process.env.AL_E2E_PARTY_PASSWORD || (fileEnv.party && fileEnv.party.password) || "party-password-123";
const RUN_MS = Number(process.env.AL_E2E_RELAY_MS || 25_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe() {
	try {
		const response = await fetch(API + "/", { signal: AbortSignal.timeout(4000) });
		return response.ok ? null : "the account API answered " + response.status;
	} catch (error) {
		return error.message;
	}
}

function framesFrom(text) {
	const out = [];
	for (const chunk of text.split("event: frame").slice(1)) {
		const body = chunk.slice(chunk.indexOf("data: ") + 6);
		const end = body.indexOf(String.fromCharCode(10, 10));
		if (end < 0) continue;
		try {
			out.push(JSON.parse(body.slice(0, end)));
		} catch {}
	}
	return out;
}

test("two clients publish, and the relay merges them into one frame the page can draw", async (t) => {
	const missing = await probe();
	if (missing) {
		t.skip("no stack at " + API + ": " + missing);
		return;
	}
	const relay = startRelay({ port: 0, rateMs: 40, log: () => {} });
	const base = await relay.started;
	const controller = new AbortController();
	const clients = [];
	const publishers = [];
	let reader = null;
	t.after(async () => {
		for (const publisher of publishers) publisher.stop();
		for (const client of clients) {
			try {
				client.disconnect();
			} catch {}
		}
		try {
			if (reader) await reader.cancel();
		} catch {}
		controller.abort();
		await relay.close();
	});
	try {
		const first = new ALClient({ apiBaseUrl: API });
		await first.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		for (const [index, name] of ["PartyTank", "PartyMage"].entries()) {
			const client = new ALClient({ apiBaseUrl: API });
			const args = { character: name, api: API, address: ADDRESS, path: ADDRESS ? "/socket.io/" : undefined, transport: "json", role: "hold", live: false };
			await bootClient({ args, client, session: first.session, cookies: first.api.cookies, log: () => {} });
			clients.push(client);
			const publisher = createPublisher(client, { url: base, role: "hold", getCounters: () => emptyCounters(), intervalMs: 100 });
			publisher.start();
			publishers.push(publisher);
			if (index === 0) await sleep(500);
		}
		const viewer = await fetch(base + "/events?watch=PartyTank", { signal: controller.signal });
		assert.equal(viewer.status, 200);
		reader = viewer.body.getReader();
		const decoder = new TextDecoder();
		let seen = "";
		let frame = null;
		const deadline = Date.now() + RUN_MS;
		while (!frame && Date.now() < deadline) {
			const chunk = await Promise.race([reader.read(), sleep(1000).then(() => ({ timeout: true }))]);
			if (chunk.timeout) continue;
			if (chunk.done) break;
			seen += decoder.decode(chunk.value, { stream: true });
			frame = framesFrom(seen).find((entry) => entry.sources && entry.sources.length >= 2) || null;
		}
		assert.ok(frame, "the relay never saw both publishers: " + seen.slice(0, 300));
		assert.equal(frame.self.id, "PartyTank", "the camera follows the watched character");
		assert.deepEqual(frame.sources.map((entry) => entry.name).sort(), ["PartyMage", "PartyTank"]);
		const players = frame.entities.players.map((entity) => String(entity.id).toLowerCase());
		for (const name of ["PartyTank", "PartyMage"]) assert.ok(players.includes(name.toLowerCase()), name + " is in the merged player list");
		for (const entry of frame.sources) {
			assert.equal(entry.map, "main");
			assert.ok(Number.isFinite(entry.x) && Number.isFinite(entry.y), "position travels with the summary");
			assert.ok(entry.max_hp > 0, "hp bars have a denominator");
		}
		const health = await (await fetch(base + "/health")).json();
		assert.equal(health.ok, true);
		assert.equal(health.sources.length, 2);
	} finally {
		for (const publisher of publishers) publisher.stop();
		for (const client of clients) {
			try {
				client.disconnect();
			} catch {}
		}
		try {
			if (reader) await reader.cancel();
		} catch {}
		controller.abort();
		await relay.close();
	}
});
