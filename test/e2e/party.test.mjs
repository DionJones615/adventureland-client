// The party e2e: three characters and a merchant, one account, one stack, working together.
//
// This is the test the compose example exists for. It drives the four real loops (loops/party/*) as
// four clients in one process and asserts the things that only cooperation produces:
//
//   * all four characters are in ONE party (leader invites, the rest request/accept);
//   * the fighters damage and kill the shared focus target, and open the loot chests it drops;
//   * the priest heals the party (the fixture starts the tank at 180 hp, so this fires immediately);
//   * the merchant casts Merchant's Luck, receives a fighter's bag, and sells it for gold.
//
// It runs against the same stack as the other e2e files (npm run e2e:up wipes the database, so the
// fixtures are the characters' state). Start from a clean stack: a character left online by an
// aborted run is a ghost whose server-side position no longer matches its document.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ALClient } from "../../client/index.mjs";
import { emptyCounters, loadLoop } from "../../scripts/bot.mjs";

let fileEnv = {};
try {
	fileEnv = JSON.parse(readFileSync(new URL("../../.e2e-env.json", import.meta.url), "utf8"));
} catch {}

const API = process.env.AL_E2E_API || fileEnv.api || "http://127.0.0.1:18090";
const ADDRESS = process.env.AL_E2E_ADDRESS || fileEnv.address || null;
const CONNECT = ADDRESS ? { address: ADDRESS, path: "/socket.io/", msgpackPath: "/socket.io-msgpack/" } : {};
// The party has its own account: one account only has five character slots, and the party needs four
// characters of its own (see scripts/e2e/container.mjs, which seeds it after the default one).
const EMAIL = process.env.AL_E2E_PARTY_EMAIL || (fileEnv.party && fileEnv.party.email) || "party@example.test";
const PASSWORD = process.env.AL_E2E_PARTY_PASSWORD || (fileEnv.party && fileEnv.party.password) || "party-password-123";

/** The role table: character, loop, party role, and the wire format deliberately mixed. */
const ROLES = {
	PartyTank: { loop: "../../loops/party/leader.mjs", role: "leader", transport: "json" },
	PartyMage: { loop: "../../loops/party/fighter.mjs", role: "fighter", transport: "msgpack" },
	PartyPriest: { loop: "../../loops/party/priest.mjs", role: "priest", transport: "json" },
	PartyMerch: { loop: "../../loops/party/merchant.mjs", role: "merchant", transport: "json" },
};

const PARTY = {
	leader: "PartyTank",
	members: ["PartyTank", "PartyMage", "PartyPriest", "PartyMerch"],
	merchant: "PartyMerch",
	// The fixtures stand the party around (-100,800); the image injects a sell point at (-193,680).
	anchor: { x: -100, y: 800 },
	sellAt: { x: -193, y: 680 },
	sendAt: 0.33,
	sellAtFill: 0.5,
	healBelow: 0.6,
};

/** Long enough for a sale (the merchant holds loot for 8 s) but not a CI tax. */
const RUN_MS = Number(process.env.AL_E2E_PARTY_MS || 90_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, { timeoutMs = 30_000, intervalMs = 250, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await sleep(intervalMs);
	}
	throw new Error("timed out waiting for " + label);
}

/** Is there a stack at all? A missing stack skips; a missing party account fails. */
async function probe() {
	try {
		const response = await fetch(API + "/");
		return response.ok ? null : "the account API answered " + response.status;
	} catch (error) {
		return error.message;
	}
}

const unavailable = await probe();
const SKIP = unavailable ? { skip: "no game stack on " + API + " - run 'npm run e2e:up' first (" + unavailable + ")" } : false;

test("three characters and a merchant of one account fight, heal and trade as one party", SKIP, async () => {
	const log = [];
	const say = (line) => log.push(line);
	const sessions = {};
	const runs = [];
	let stopped = false;
	const deadline = Date.now() + RUN_MS;
	const shouldStop = () => stopped || Date.now() >= deadline;

	try {
		const probeClient = new ALClient({ apiBaseUrl: API });
		await probeClient.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		const owned = ((await probeClient.characters()) || []).map((entry) => entry.name);
		for (const name of Object.keys(ROLES)) {
			assert.ok(owned.some((entry) => entry.toLowerCase() === name.toLowerCase()), name + " is seeded on " + EMAIL + " (have " + owned.join(",") + ")");
		}

		for (const [name, config] of Object.entries(ROLES)) {
			const client = new ALClient({ apiBaseUrl: API });
			const dropped = [];
			client.on("disconnected", (reason) => dropped.push(reason || "unknown"));
			await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
			await client.connect({ transport: config.transport, ...CONNECT });
			await client.enter(name);
			const loop = await loadLoop(new URL(config.loop, import.meta.url).pathname);
			sessions[name] = { client, loop, dropped, counters: emptyCounters(), transport: config.transport };
			say("[e2e] " + name + " online (" + config.transport + ", loop " + loop.meta.name + ")");
		}

		// Four loops, four clients, one process: each is a normal run(context) loop.
		for (const [name, session] of Object.entries(sessions)) {
			const run = session.loop.run({
				client: session.client,
				log: (line) => say("[" + name + "] " + line),
				counters: session.counters,
				sleep,
				config: {},
				args: { party: PARTY },
				party: { ...PARTY, role: ROLES[name].role },
				deadline,
				shouldStop,
			});
			runs.push(
				Promise.resolve(run).catch((error) => {
					session.counters.failures++;
					say("[" + name + "] loop ended with an error: " + (error && error.message ? error.message : error));
				}),
			);
		}

		// 1. Every client sees the same four-name roster.
		await until(
			() =>
				Object.entries(sessions).every(([, session]) => {
					const list = (session.client.world.party && session.client.world.party.list) || [];
					return list.length >= 4 && PARTY.members.every((name) => list.some((entry) => entry.toLowerCase() === name.toLowerCase()));
				}),
			{ timeoutMs: 45_000, label: "all four characters in one party" },
		);
		for (const [name, session] of Object.entries(sessions)) {
			assert.equal((session.client.world.party.list || []).length, 4, name + " sees a four-member party");
		}

		// 2. The fighters damage and kill the shared target.
		const total = (key) => Object.values(sessions).reduce((sum, session) => sum + (session.counters[key] || 0), 0);
		await until(() => total("attacks") >= 5 && total("hits") >= 5, { timeoutMs: 45_000, label: "the fighters land hits" });
		// The warrior has a 16-unit reach, so this is the slowest of the three to connect - and the one
		// worth waiting for, because it proves the melee character is not just sweeping chests.
		await until(() => sessions.PartyTank.counters.attacks > 0, { timeoutMs: 45_000, label: "the leader lands an attack" });
		await until(() => total("kills") > 0, { timeoutMs: 45_000, label: "the party kills a monster" });

		// 3. The merchant took a handover from the tank, buffed the party, and sold the loot.
		await until(() => sessions.PartyTank.counters.sent > 0 && sessions.PartyMerch.counters.received > 0, {
			timeoutMs: 40_000,
			label: "the tank hands its bag to the merchant",
		});
		await until(() => sessions.PartyMerch.counters.buffs > 0, { timeoutMs: 40_000, label: "Merchant's Luck is cast" });
		await until(() => sessions.PartyMerch.counters.sold > 0 && sessions.PartyMerch.counters.gold > 0, {
			timeoutMs: 45_000,
			label: "the merchant sells what it received",
		});

		// 4. The priest healed the group (the fixture starts the tank below the heal threshold).
		await until(() => sessions.PartyPriest.counters.heals > 0, { timeoutMs: 40_000, label: "the priest heals the party" });

		// 5. Loot piles are actually opened, not just walked over.
		await until(() => total("chests") > 0, { timeoutMs: 45_000, label: "a loot chest is opened" });

		stopped = true;
		await Promise.all(runs);

		// The report: what the party actually did, per character.
		for (const [name, session] of Object.entries(sessions)) {
			const counters = session.counters;
			say(
				"[e2e] " + name + ": " + counters.attacks + " attacks, " + counters.hits + " hits, " + counters.chests + " chests, " + counters.sent + " sent, " +
					counters.received + " received, " + counters.heals + " heals, " + counters.buffs + " buffs, " + counters.sold + " sold, " + counters.gold + " gold",
			);
			assert.deepEqual(session.dropped, [], name + " stayed connected for the whole run");
		}
		assert.ok(total("attacks") >= 5, "the party fought (a warrior's reach is 18 units, a mage's is 120)");
		assert.ok(total("kills") > 0, "and killed something (a party kill counts for everyone who engaged it)");
		assert.ok(sessions.PartyTank.counters.attacks > 0, "the leader fought at melee reach");
		assert.ok(sessions.PartyMage.counters.attacks > 0, "the mage fought through the msgpack transport");
		assert.ok(sessions.PartyPriest.counters.heals > 0, "the priest healed");
		assert.ok(sessions.PartyMerch.counters.received > 0, "the merchant received loot");
		assert.ok(sessions.PartyMerch.counters.sold > 0, "the merchant sold it");
	} catch (error) {
		say("[e2e] party run failed: " + (error && error.message ? error.message : error));
		throw error;
	} finally {
		stopped = true;
		if (process.env.AL_E2E_PARTY_LOGS !== "0") {
			for (const line of log.slice(-160)) console.log(line);
		}
		await Promise.allSettled(runs);
		for (const session of Object.values(sessions)) session.client.disconnect();
	}
});
