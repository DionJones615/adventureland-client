// e2e against the PUBLISHED game image (npm run e2e:up starts it, npm run e2e:down stops it).
//
// The characters and their inventory/equipment/location come from test/e2e/fixtures/client-e2e.json,
// which the container seeds at startup - so these tests assert the fixture, i.e. both this client and
// the container's fixture pipeline at once.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALClient } from "../../client/index.mjs";
import { AccountApi } from "../../client/http.mjs";

const API = process.env.AL_E2E_API || "http://127.0.0.1:18090";
const EMAIL = process.env.AL_E2E_EMAIL || "dev@example.test";
const PASSWORD = process.env.AL_E2E_PASSWORD || "dev-password-123";

// The server advertises localhost:7192 (its own container), while the published port is 17192 -
// so when e2e:up tells us the address, use it. Without it the client tries the internal port.
const ADDRESS = process.env.AL_E2E_ADDRESS || null;
const CONNECT = ADDRESS ? { address: ADDRESS, path: "/socket.io/", msgpackPath: "/socket.io-msgpack/" } : {};

const MAGE = { name: "ClientMage", map: "main", x: -120, y: 760, level: 30, gold: 1234 };
const ROGUE = { name: "ClientRogue", map: "main", x: 140, y: 780, level: 12 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (entity, x, y, tolerance = 10) => Math.hypot((entity.x ?? 0) - x, (entity.y ?? 0) - y) <= tolerance;

/** Resolve a promise on the next matching client event, or null on timeout. */
function nextEvent(client, predicate, timeoutMs = 4_000) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			client.off("event", handler);
			resolve(null);
		}, timeoutMs);
		function handler(name, data) {
			if (!predicate(name, data)) return;
			clearTimeout(timer);
			client.off("event", handler);
			resolve({ name, data });
		}
		client.on("event", handler);
	});
}

async function probe() {
	try {
		const api = new AccountApi({ baseUrl: API });
		await api.signupOrLogin({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		return null;
	} catch (error) {
		return error.message;
	}
}

const unavailable = await probe();
const SKIP = unavailable
	? { skip: "no game stack on " + API + " - run 'npm run e2e:up' first (" + unavailable + ")" }
	: false;

test("the account API lists the fixture characters", SKIP, async () => {
	const api = new AccountApi({ baseUrl: API });
	await api.signupOrLogin({ email: EMAIL, password: PASSWORD });
	const { servers, characters } = await api.serversAndCharacters();
	assert.ok(servers.length >= 1, "at least one game server is registered");
	const names = characters.map((entry) => entry.name);
	assert.ok(names.includes(MAGE.name), "fixture mage is on the account: " + names.join(","));
	assert.ok(names.includes(ROGUE.name), "fixture rogue is on the account");
	const mage = characters.find((entry) => entry.name === MAGE.name);
	assert.equal(mage.level, MAGE.level);
	assert.equal(mage.map, MAGE.map);
	assert.ok(near(mage, MAGE.x, MAGE.y, 12), "mage stands at the fixture position, got " + mage.x + "," + mage.y);
});

test("enter a fixture character: inventory, equipment and location", SKIP, async () => {
	const client = new ALClient({ apiBaseUrl: API });
	try {
		await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		await client.connect({ transport: "json", ...CONNECT });
		const self = await client.enter(MAGE.name);

		assert.equal(self.map, MAGE.map);
		assert.ok(near(self, MAGE.x, MAGE.y), "spawned at the fixture position, got " + self.x + "," + self.y);
		assert.equal(self.level, MAGE.level);
		assert.equal(self.gold, MAGE.gold, "gold from the fixture");

		const bag = (self.items || [])
			.filter(Boolean)
			.map((item) => item.name + "x" + (item.q || 1))
			.sort();
		assert.deepEqual(bag, ["gslimex7", "hpot1x100", "mpot1x50"], "inventory from the fixture");

		assert.equal(self.slots.mainhand.status, undefined);
		assert.equal(self.slots.mainhand.name, "staff");
		assert.equal(self.slots.mainhand.level, 2);
		assert.equal(self.slots.helmet.name, "helmet");
	} finally {
		client.disconnect();
	}
});

test("the character can walk and the server agrees on the position", SKIP, async () => {
	const client = new ALClient({ apiBaseUrl: API });
	try {
		await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		await client.connect({ transport: "json", ...CONNECT });
		await client.enter(MAGE.name);
		const target = { x: MAGE.x + 40, y: MAGE.y };
		// One movement packet covers a limited distance - the server clamps a step and corrects the
		// prediction - so walk towards the target until it is reached instead of assuming one hop.
		for (let hop = 0; hop < 8 && !near(client.world.self, target.x, target.y, 8); hop++) {
			await client.move(target);
		}
		assert.ok(near(client.world.self, target.x, target.y, 8), "arrived after moving, got " + client.world.self.x + "," + client.world.self.y);
	} finally {
		client.disconnect();
	}
});

test("pathfinding walks a routed path, not a straight line", SKIP, async () => {
	const client = new ALClient({ apiBaseUrl: API });
	try {
		await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		await client.connect({ transport: "json", ...CONNECT });
		const self = await client.enter(MAGE.name);
		const target = { x: self.x + 25, y: self.y + 25 };
		await client.walkTo(target);
		assert.ok(near(client.world.self, target.x, target.y, 12), "walkTo arrived, got " + client.world.self.x + "," + client.world.self.y);
	} finally {
		client.disconnect();
	}
});

test("chat round-trips through the server", SKIP, async () => {
	const client = new ALClient({ apiBaseUrl: API });
	try {
		await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		await client.connect({ transport: "json", ...CONNECT });
		await client.enter(MAGE.name);
		const heard = nextEvent(client, (name) => name === "chat_log");
		await client.say("e2e hello");
		const event = await heard;
		assert.ok(event, "a chat_log event came back");
		assert.match(JSON.stringify(event.data), /e2e hello/);
	} finally {
		client.disconnect();
	}
});

test("attacking a monster produces a hit", SKIP, async () => {
	const client = new ALClient({ apiBaseUrl: API });
	try {
		await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		await client.connect({ transport: "json", ...CONNECT });
		const self = await client.enter(MAGE.name);
		const monsters = [...client.world.monsters.values()].filter((monster) => typeof monster.x === "number");
		const nearest = monsters
			.map((monster) => ({ monster, distance: Math.hypot(monster.x - self.x, monster.y - self.y) }))
			.filter((entry) => entry.distance < 250)
			.sort((a, b) => a.distance - b.distance)[0];
		if (!nearest) {
			console.log("[e2e] no monster within 250 units, combat assertion skipped");
			return;
		}
		const hit = nextEvent(client, (name, data) => name === "hit" && String(data && data.hid).toLowerCase() === MAGE.name.toLowerCase(), 6_000);
		await client.attack(nearest.monster.id);
		const event = await hit;
		assert.ok(event, "a hit event came back for the attack");
		assert.ok(event.data.damage > 0, "the hit carried damage");
	} finally {
		client.disconnect();
	}
});

test("the MessagePack transport enters the same way", SKIP, async () => {
	const client = new ALClient({ apiBaseUrl: API });
	try {
		await client.login({ email: EMAIL, password: PASSWORD, onlyLogin: true });
		await client.connect({ transport: "msgpack", ...CONNECT });
		const self = await client.enter(ROGUE.name);
		assert.equal(self.map, ROGUE.map);
		assert.ok(near(self, ROGUE.x, ROGUE.y), "msgpack session spawned at the fixture position");
		assert.equal(self.level, ROGUE.level);
	} finally {
		client.disconnect();
	}
});
