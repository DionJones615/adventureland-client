// The bot runtime: account bootstrap, connect, enter, and the loop driver.
//
// scripts/bot.mjs is the CLI for one character; scripts/live/party.mjs drives a whole party in one
// process with one login. Both need exactly this plumbing, so it lives here and neither owns it.
//
// A loop exports either decide(state) (pure: the runner executes the returned action) or
// run({client, log, counters, sleep, config}) (full control). See loops/README.md.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALClient } from "../../client/index.mjs";
import { DEFAULTS } from "./loop.mjs";
import { findMerchant, sellItems } from "./vendor.mjs";
import { parseAnchor } from "./party.mjs";

export const LOCAL_API = "http://127.0.0.1:8090";
export const DEFAULT_EMAIL = "dev@example.test";
export const DEFAULT_PASSWORD = "dev-password-123";
export const DEFAULT_LOOP = new URL("../../loops/basic.mjs", import.meta.url).pathname;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this account API a local stack rather than the live game?
 *
 * Loopback, a container/service name ("al-game"), a private address and the usual local suffixes all
 * count: the compose example talks to http://al-game:8090 from inside the network, and treating that
 * as the live game would refuse to run the very example this repository ships.
 */
export function isLocalApi(api) {
	let host;
	try {
		host = new URL(String(api || "")).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (!host) return false;
	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
	// A single label is a container/compose service name (al-game, game, backend).
	if (!host.includes(".")) return true;
	if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || host.endsWith(".test") || host.endsWith(".home.arpa")) return true;
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (ipv4) {
		const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
		if (a === 127 || a === 10) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}
	return false;
}

/**
 * Refuse to touch a remote account API unless the caller said so explicitly. Everything else in this
 * repository assumes a throwaway local stack; the live game is a different decision, made by a human.
 */
export function requireLiveAck({ api, live, log = () => {} } = {}) {
	if (isLocalApi(api) || live) return true;
	log("refusing to run against " + api + " - this is a remote account API (the live game).");
	log("re-run with --live once you mean to touch it; the party defaults there are hold, no send, no sell.");
	return false;
}

/**
 * How long to run, in milliseconds. Zero and negatives mean "until SIGTERM": that is what the image
 * sets (AL_BOT_SECONDS=0), and a container that exits on start is never what anyone meant.
 */
export function resolveRunWindow(seconds) {
	const value = Number(seconds);
	return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : Infinity;
}

/** Load and validate a loop module. Exactly one of decide()/run() must be exported. */
export async function loadLoop(specPath) {
	const absolute = path.resolve(specPath);
	const module = await import(pathToFileURL(absolute).href);
	const decide = typeof module.decide === "function" ? module.decide : null;
	const run = typeof module.run === "function" ? module.run : null;
	if (!decide && !run) {
		throw new Error("loop " + absolute + " exports neither decide(state) nor run(context) - see loops/README.md");
	}
	return { path: absolute, decide, run, meta: module.meta || {} };
}

/** The party section of the loop config, from env/flags. Absent values stay null. */
export function partyConfig(args) {
	const anchor = parseAnchor(args.anchor);
	const sellAt = parseAnchor(args.sellAt);
	const members = typeof args.members === "string" && args.members.trim() ? args.members.split(",").map((name) => name.trim()).filter(Boolean) : [];
	const targets = typeof args.targets === "string" && args.targets.trim() ? args.targets.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean) : [];
	const keepSell = typeof args.keepSell === "string" && args.keepSell.trim() ? args.keepSell.split(",").map((name) => name.trim()).filter(Boolean) : [];
	return {
		role: args.role || null,
		leader: args.leader || null,
		members,
		merchant: args.partyMerchant || null,
		anchor,
		sellAt,
		sendAt: numberOr(args.sendAt, null),
		sellAtFill: numberOr(args.sellAtFill, null),
		healBelow: numberOr(args.healBelow, null),
		// Live safety gates. Unset keeps the local behaviour exactly as before.
		targets,
		sendEnabled: args.sendEnabled !== false,
		sellEnabled: args.sellEnabled !== false,
		ownLoot: args.ownLoot === true,
		keepSell,
	};
}

function numberOr(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function emptyCounters() {
	return {
		attacks: 0,
		patrols: 0,
		steps: 0,
		potions: 0,
		respawns: 0,
		says: 0,
		failures: 0,
		hits: 0,
		damage: 0,
		kills: 0,
		sold: 0,
		gold: 0,
		looted: 0,
		// chests are the loot piles actually opened (walking over one collects nothing);
		// sent/received/heals/buffs belong to the party loops.
		chests: 0,
		sent: 0,
		received: 0,
		heals: 0,
		buffs: 0,
	};
}

/** Where to log in and which server to play on. --address overrides the advertised game socket. */
export async function connectTarget(client, args) {
	if (args.address) return { address: args.address, path: args.path || undefined };
	if (args.server) return { server: args.server };
	return {};
}

async function connectWithRetry(client, args, log) {
	const target = await connectTarget(client, args);
	for (let attempt = 1; ; attempt++) {
		try {
			return await client.connect({ transport: args.transport || "json", ...target });
		} catch (error) {
			// A failed transport leaves a half-built socket behind: tear it down, or every retry is
			// answered with "already connected" instead of trying again.
			try {
				client.socket = null;
				client.disconnect();
			} catch {}
			if (attempt >= 12) throw error;
			log("connect failed (" + error.message + "), retrying " + attempt + "/12");
			await sleep(3_000);
		}
	}
}

async function ensureAccount(client, args, log) {
	const email = args.email || DEFAULT_EMAIL;
	const password = args.password || DEFAULT_PASSWORD;
	for (let attempt = 1; attempt <= 200; attempt++) {
		try {
			await loginOrSignup(client, email, password, log, args);
			await ensureCharacter(client, args.character, log, args);
			return;
		} catch (error) {
			if (attempt === 200) throw error;
			log("account setup " + attempt + "/200 failed (" + error.message + "), retrying");
			await sleep(3_000);
		}
	}
}

async function loginOrSignup(client, email, password, log, args) {
	try {
		await client.login({ email, password, onlyLogin: true });
		return;
	} catch (error) {
		// The live game is not a place to create accounts by accident.
		if (args.live) throw new Error("login on " + args.api + " failed: " + error.message + " (live runs never sign up)");
		if (!/email_not_found|no_account|not_found/i.test(String(error.message))) throw error;
	}
	log("account missing, signing up " + email);
	await client.api.signupOrLogin({ email, password });
	await client.login({ email, password, onlyLogin: true });
}

async function ensureCharacter(client, name, log, args) {
	const characters = await client.characters().catch(() => null);
	if (!characters) return;
	const names = (characters || []).map((entry) => (entry.name || "").toLowerCase());
	if (names.includes(name.toLowerCase())) return;
	// Same rule as signup: a live run may not conjure characters.
	if (args.live) throw new Error("character " + name + " does not exist on this account (live runs never create characters)");
	log("creating character " + name);
	await client.createCharacter({ name, char: "mage", look: 0 });
}

/**
 * Login (or signup, locally), connect, enter the character. Returns the client plus the self entity
 * the server sent with "player".
 */
export async function bootClient({ args, log = () => {}, client = null, session = null, cookies = null } = {}) {
	const runner = client || new ALClient({ apiBaseUrl: args.api || LOCAL_API });
	runner.on("disconnected", (reason) => log("disconnected: " + (reason || "unknown")));
	// A party logs in once and hands the session to its four clients: four logins look like four
	// independent sessions to the account backend, and the last one wins. The account API is
	// cookie-based, so the jar has to travel with the session or every call is "not_logged_in".
	if (session) runner.session = session;
	if (cookies) runner.api.cookies = new Map(cookies);
	if (!runner.session) {
		log("logging in as " + args.character + " via " + runner.apiBaseUrl);
		await ensureAccount(runner, args, log);
	}
	await connectWithRetry(runner, args, log);
	const entered = await runner.enter(args.character);
	log("entered " + args.character + " at " + Math.round(entered.x) + "," + Math.round(entered.y) + " in " + entered.map);
	return { client: runner, entered };
}

/**
 * Run one loaded loop for one client until shouldStop(), then print the summary.
 *
 * The caller owns signals, deadlines and counters: a CLI has one character, a party has four, and
 * neither should be able to stop the other's timers by accident.
 */
export async function driveLoop({
	client,
	loop,
	args,
	log = () => {},
	counters = emptyCounters(),
	started = Date.now(),
	deadline = Infinity,
	shouldStop = () => Date.now() >= deadline,
	onSummary = () => {},
	publish = null,
}) {
	const party = partyConfig(args);
	const config = { sayText: DEFAULTS.sayText, ...(Number.isFinite(args.vendorAt) ? { vendorAt: args.vendorAt } : {}), party };

	client.on("event", (name, data) => {
		if (name === "hit" && data && String(data.hid).toLowerCase() === args.character.toLowerCase()) {
			counters.hits++;
			counters.damage += data.damage || 0;
		}
	});

	try {
		if (loop.run) {
			await loop.run({
				client,
				log,
				counters,
				sleep,
				config,
				args,
				party,
				deadline,
				shouldStop,
				publish,
			});
		} else {
			await decideLoop({ client, loop, args, log, counters, config, started, shouldStop });
		}
	} finally {
		try {
			client.disconnect();
		} catch {}
	}

	const elapsed = Math.round((Date.now() - started) / 1000);
	const line =
		"ran " + elapsed + "s: " + counters.attacks + " attacks (" + counters.hits + " hits, " + Math.round(counters.damage) + " damage, " + counters.kills + " kills), " +
		counters.chests + " chests, " + counters.sold + " sold for " + counters.gold + " gold, " + counters.steps + " steps, " + counters.says + " says, " +
		counters.potions + " potions, " + counters.respawns + " respawns, " + counters.failures + " failures";
	onSummary(line, counters, { character: args.character, role: party.role, elapsed });
	// Machine readable, so an e2e can assert on counters instead of parsing prose.
	onSummary("summary " + JSON.stringify({ character: args.character, role: party.role, elapsed, counters }), counters, { raw: true });
	return counters;
}

/** The decide(state) contract: ask the loop, execute the action, repeat. */
async function decideLoop({ client, loop, args, log, counters, config, started, shouldStop }) {
	const anchor = { x: client.world.self.x, y: client.world.self.y };
	const avoided = new Map();
	const attempts = new Map();
	const culled = new Set();
	const counted = new Set();
	const drops = new Map();
	let nextAttackAt = 0;
	let nextSayAt = args.say ? Date.now() + DEFAULTS.sayEveryMs : 0;
	let focusId = null;
	let step = 0;

	const giveUp = (id, reason) => {
		if (!id) return;
		avoided.set(String(id), Date.now() + 60_000);
		log("giving up on " + id + " (" + reason + ")");
	};

	client.on("event", (name, data) => {
		if (name === "disappear" && data && data.outside) culled.add(String(data.id));
		if (name === "drop" && data && typeof data.x === "number") drops.set(String(data.id), { id: data.id, x: data.x, y: data.y, at: Date.now() });
		if (name === "game_response" && data && data.response === "too_far") giveUp(data.id, "too_far");
		if (name === "game_response" && data && data.response === "cooldown" && data.place === "attack" && data.ms) nextAttackAt = Math.max(nextAttackAt, Date.now() + data.ms + 60);
	});

	while (!shouldStop()) {
		const now = Date.now();
		const self = client.world.self;
		const monsters = [...client.world.monsters.values()];
		const attackRange = Math.max(40, Math.round((self && self.range ? self.range : DEFAULTS.attackRange) - 15));

		for (const [id, until] of avoided) if (until <= now) avoided.delete(id);
		for (const [id, drop] of drops) if (now - drop.at > 60_000) drops.delete(id);
		for (const id of attempts.keys()) {
			if (counted.has(id) || culled.has(id) || client.world.monsters.has(id)) continue;
			counted.add(id);
			counters.kills++;
			log("killed " + id);
		}
		if (focusId !== null && !monsters.some((monster) => String(monster.id) === String(focusId))) focusId = null;

		const action = loop.decide({
			self,
			monsters,
			drops: [...drops.values()],
			anchor,
			step,
			now,
			nextSayAt,
			attackReadyAt: nextAttackAt,
			focus: focusId,
			avoid: new Set(avoided.keys()),
			config: { ...config, attackRange },
		});

		try {
			if (action.type === "respawn") {
				await client.respawn();
				counters.respawns++;
			} else if (action.type === "potion" || action.type === "mana") {
				await client.use(action.item);
				counters.potions++;
				log("used " + action.item);
				await sleep(4_200);
			} else if (action.type === "attack") {
				focusId = action.id;
				await client.attack(action.id);
				counters.attacks++;
				const swings = (attempts.get(String(action.id)) || 0) + 1;
				attempts.set(String(action.id), swings);
				if (swings >= 15) giveUp(action.id, "no damage after " + swings + " swings");
				if (self && self.frequency) nextAttackAt = Math.max(nextAttackAt, Date.now() + Math.round(1_000 / self.frequency));
			} else if (action.type === "say" && args.say) {
				await client.say(action.text + " " + (counters.says + 1));
				counters.says++;
				nextSayAt = Date.now() + DEFAULTS.sayEveryMs;
			} else if (action.type === "loot") {
				drops.delete(String(action.drop.id));
				await client.move({ x: action.drop.x, y: action.drop.y, timeoutMs: 20_000 }).catch(() => {});
				counters.looted++;
				// Walking over a chest collects nothing: the server only grants its contents to an
				// open_chest request (the browser client sends one when you click the pile).
				const opened = await client.openChest(action.drop.id).catch(() => null);
				if (opened && opened.failed) {
					log("loot refused: " + (opened.response || "unknown"));
					if (opened.response !== "loot_no_space") counters.failures++;
				} else if (opened) {
					counters.chests++;
					log("opened a chest (" + ((opened.items || []).length) + " items, " + (opened.gold || 0) + " gold)");
				}
			} else if (action.type === "chase") {
				const from = { x: client.world.self.x, y: client.world.self.y };
				if (client.pathfinder.canWalkDirect(client.world.map, from, action.target)) {
					await client.move(action.target);
					counters.steps++;
				} else giveUp(action.id, "not reachable");
			} else if (action.type === "patrol") {
				const from = { x: client.world.self.x, y: client.world.self.y };
				if (client.pathfinder.canWalkDirect(client.world.map, from, action.target)) {
					await client.move(action.target);
					counters.patrols++;
				} else step++;
			} else if (action.type === "vendor") {
				let result = await sellItems(client, action.items, log);
				counters.sold += result.sold;
				counters.gold += result.gold;
				if (result.left.length) {
					const merchant = findMerchant(client, args.merchant);
					if (merchant) {
						await client.walkTo({ x: merchant.x, y: merchant.y, timeoutMs: 60_000 }).catch(() => {});
						result = await sellItems(client, result.left, log);
						counters.sold += result.sold;
						counters.gold += result.gold;
						await client.walkTo({ x: anchor.x, y: anchor.y, timeoutMs: 60_000 }).catch(() => {});
					}
				}
			} else if (action.type === "idle") {
				await sleep(Math.min(400, Math.max(50, action.until - Date.now())));
			}
		} catch (error) {
			counters.failures++;
			log(action.type + " failed: " + error.message);
		}

		step++;
		if (client.world.self && Math.hypot(client.world.self.x - anchor.x, client.world.self.y - anchor.y) > 600) {
			anchor.x = client.world.self.x;
			anchor.y = client.world.self.y;
		}
		await sleep(DEFAULTS.tickMs);
	}
	void started;
}
