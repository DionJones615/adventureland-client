// Two clients, one account, two characters, online at the same time.
//
// This is the one case a single-session suite cannot cover: two sockets logged into the same account,
// each driving a different character, seeing each other in the world. One speaks JSON, the other
// MessagePack, so the pairing also proves the transports coexist.
//
// Run against a clean stack (npm run e2e:up wipes the database): a character left online by an
// aborted run is a "ghost" whose server-side position drifts from its document, which makes
// visibility assertions lie.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ALClient } from "../../client/index.mjs";

let fileEnv = {};
try {
	fileEnv = JSON.parse(readFileSync(new URL("../../.e2e-env.json", import.meta.url), "utf8"));
} catch {}

const API = process.env.AL_E2E_API || fileEnv.api || "http://127.0.0.1:18090";
const ADDRESS = process.env.AL_E2E_ADDRESS || fileEnv.address || null;
const CONNECT = ADDRESS ? { address: ADDRESS, path: "/socket.io/", msgpackPath: "/socket.io-msgpack/" } : {};
const EMAIL = process.env.AL_E2E_EMAIL || "dev@example.test";
const PASSWORD = process.env.AL_E2E_PASSWORD || "dev-password-123";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, { timeoutMs = 10_000, intervalMs = 200, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await sleep(intervalMs);
	}
	throw new Error("timed out waiting for " + label);
}

async function enter(name, transport) {
	const client = new ALClient({ apiBaseUrl: API });
	const dropped = [];
	client.on("event", (event, data) => {
		if (event === "disconnected") dropped.push(data || "unknown");
	});
	await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
	await client.connect({ transport, ...CONNECT });
	const self = await client.enter(name);
	return { client, self, dropped };
}

test("two characters of one account are online at once and see each other", async () => {
	let mage;
	let rogue;
	try {
		mage = await enter("ClientMage", "json");
		rogue = await enter("ClientRogue", "msgpack");

		// Both sessions are real and on the same server/map.
		assert.equal(mage.self.id, "ClientMage");
		assert.equal(rogue.self.id, "ClientRogue");
		assert.equal(mage.client.world.map, rogue.client.world.map);

		// The fixtures place them ~260 units apart, inside each other's vision.
		const sees = async (label) => {
			try {
				return await until(() => mage.client.world.players.get("ClientRogue") && rogue.client.world.players.get("ClientMage"), {
					timeoutMs: 6_000,
					label,
				});
			} catch {
				return null;
			}
		};

		let mutual = await sees("mutual visibility at the fixture positions");
		if (!mutual) {
			// Drifted characters (an earlier run moved them): walk the rogue onto the mage and retry.
			const magePosition = { x: Math.round(mage.client.world.self.x), y: Math.round(mage.client.world.self.y) };
			const target = { x: magePosition.x + 15, y: magePosition.y };
			for (let hop = 0; hop < 60; hop++) {
				const me = rogue.client.world.self;
				if (Math.hypot(me.x - target.x, me.y - target.y) < 8) break;
				await rogue.client.move(target).catch(() => {});
			}
			mutual = await sees("mutual visibility after walking together");
		}
		assert.ok(mutual, "each character appears in the other's world");
		assert.ok(mage.client.world.players.get("ClientRogue"), "the mage sees the rogue");
		assert.ok(rogue.client.world.players.get("ClientMage"), "the rogue sees the mage");

		// Movement of one is streamed to the other: move the rogue and watch the mage's copy of it move.
		// Compare against where the mage last saw it rather than against the rogue's locally predicted
		// position - the server clamps a step and corrects the mover, so the two are not identical.
		const seenBefore = { ...mage.client.world.players.get("ClientRogue") };
		const moveTarget = { x: Math.round(rogue.client.world.self.x), y: Math.round(rogue.client.world.self.y) - 45 };
		for (let hop = 0; hop < 6; hop++) await rogue.client.move(moveTarget).catch(() => {});
		await until(
			() => {
				const seen = mage.client.world.players.get("ClientRogue");
				if (!seen) return false;
				return Math.hypot(seen.x - seenBefore.x, seen.y - seenBefore.y) >= 15;
			},
			{ timeoutMs: 8_000, label: "the mage's copy of the rogue moves" },
		);

		// The second login did not evict the first, and vice versa.
		assert.deepEqual(mage.dropped, [], "the JSON session stayed connected");
		assert.deepEqual(rogue.dropped, [], "the MessagePack session stayed connected");
	} finally {
		mage?.client.disconnect();
		rogue?.client.disconnect();
	}
});
