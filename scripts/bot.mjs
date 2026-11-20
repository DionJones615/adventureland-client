#!/usr/bin/env node
// The bot runner: a loop-agnostic driver over the protocol client.
//
//   node scripts/bot.mjs --character Devmage --seconds 120
//   node scripts/bot.mjs --character Devmage --loop ./my-loops/aggressive.mjs
//   node scripts/bot.mjs --character PartyMerch --loop ./loops/party/merchant.mjs --seconds 0
//
// The runner owns the plumbing - login, account/character bootstrap, connect, action execution,
// counters - and asks a loop module what to do. Loops are plain ES modules and can be mounted into
// the image, so a strategy never requires a rebuild:
//
//   docker run --rm --network al -v "$PWD/my-loops:/loops:ro" -e BOT_LOOP=/loops/aggressive.mjs ...
//
// A loop exports either decide(state) (pure: the runner executes the returned action) or
// run({client, log, counters, sleep, config}) (full control). See loops/README.md.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { ALClient } from "../client/index.mjs";
import { DEFAULTS } from "./bot/loop.mjs";
import { findMerchant, sellItems } from "./bot/vendor.mjs";
import { parseAnchor } from "./bot/party.mjs";

const LOCAL_API = "http://127.0.0.1:8090";
const DEFAULT_EMAIL = "dev@example.test";
const DEFAULT_PASSWORD = "dev-password-123";
const DEFAULT_LOOP = new URL("../loops/basic.mjs", import.meta.url).pathname;

function numberOr(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
	const args = {
		character: process.env.AL_BOT_CHARACTER || "Devmage",
		seconds: Number(process.env.AL_BOT_SECONDS || 300),
		say: process.env.AL_BOT_SAY !== "0",
		transport: process.env.AL_BOT_TRANSPORT || "json",
		api: process.env.AL_API || process.env.AL_BOT_API || LOCAL_API,
		address: process.env.AL_GAME_ADDRESS || null,
		email: process.env.AL_BOT_EMAIL || null,
		password: process.env.AL_BOT_PASSWORD || null,
		loop: process.env.BOT_LOOP || null,
		vendorAt: process.env.AL_BOT_VENDOR_AT ? Number(process.env.AL_BOT_VENDOR_AT) : null,
		merchant: null,
		// Party knobs. The loops read them from config.party; every one is optional, so the runner
		// stays usable without a party at all.
		role: process.env.AL_PARTY_ROLE || null,
		leader: process.env.AL_PARTY_LEADER || null,
		members: process.env.AL_PARTY_MEMBERS || null,
		partyMerchant: process.env.AL_PARTY_MERCHANT || null,
		anchor: process.env.AL_PARTY_ANCHOR || null,
		sellAt: process.env.AL_PARTY_SELL_AT || null,
		sendAt: process.env.AL_PARTY_SEND_AT || null,
		sellAtFill: process.env.AL_PARTY_SELL_AT_FILL || null,
		healBelow: process.env.AL_PARTY_HEAL_BELOW || null,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(flag + " needs a value");
			return argv[++i];
		};
		if (flag === "--character" || flag === "-c") args.character = next();
		else if (flag === "--seconds" || flag === "-s") args.seconds = Number(next());
		else if (flag === "--api") args.api = next();
		else if (flag === "--address") args.address = next();
		else if (flag === "--email") args.email = next();
		else if (flag === "--password") args.password = next();
		else if (flag === "--transport") args.transport = next();
		else if (flag === "--loop" || flag === "-l") args.loop = next();
		else if (flag === "--vendor-at") args.vendorAt = Number(next());
		else if (flag === "--party-role") args.role = next();
		else if (flag === "--party-leader") args.leader = next();
		else if (flag === "--party-members") args.members = next();
		else if (flag === "--party-merchant") args.partyMerchant = next();
		else if (flag === "--party-anchor") args.anchor = next();
		else if (flag === "--party-sell-at") args.sellAt = next();
		else if (flag === "--merchant") {
			const [x, y] = next().split(",").map(Number);
			args.merchant = { x, y };
		} else if (flag === "--no-say") args.say = false;
		else if (flag === "--quiet" || flag === "-q") args.quiet = true;
		else if (flag === "--help" || flag === "-h") args.help = true;
		else throw new Error("unknown flag: " + flag);
	}
	return args;
}

const USAGE = [
	"usage: node scripts/bot.mjs [options]",
	"",
	"  --character, -c <name>    character to drive (default Devmage)",
	"  --seconds, -s <n>         how long to run; 0 or a negative number runs until SIGTERM (default 300)",
	"  --loop, -l <path>         loop module to run (default loops/basic.mjs, env BOT_LOOP)",
	"  --api <url>               account API base (default http://127.0.0.1:8090)",
	"  --address <host:port>     game socket address override (env AL_GAME_ADDRESS); needed when the",
	"                            server advertises localhost but you connect from a container",
	"  --email/--password        account credentials (default dev@example.test / dev-password-123)",
	"  --transport <json|msgpack>  wire format (default json)",
	"  --merchant <x,y>          sell here instead of the map merchant",
	"  --vendor-at <0..1>        sell once the bag is this full (default 0.95)",
	"  --party-role <role>       label passed to the loop (env AL_PARTY_ROLE)",
	"  --party-leader <name>     the character that owns the party (env AL_PARTY_LEADER)",
	"  --party-members <a,b,c>   members the leader invites (env AL_PARTY_MEMBERS)",
	"  --party-merchant <name>   the merchant that receives and sells loot (env AL_PARTY_MERCHANT)",
	"  --party-anchor <x,y>      the point the party fights around (env AL_PARTY_ANCHOR)",
	"  --party-sell-at <x,y>     where the party sells (env AL_PARTY_SELL_AT)",
	"  --no-say                  do not chat",
	"  --quiet, -q               only print the summary",
].join("\n");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
	};
}

async function connectWithRetry(client, args, log) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await client.connect({ transport: args.transport, ...(args.address ? { address: args.address } : {}) });
		} catch (error) {
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
			await loginOrSignup(client, email, password, log);
			await ensureCharacter(client, args.character, log);
			return;
		} catch (error) {
			if (attempt === 200) throw error;
			log("account setup " + attempt + "/200 failed (" + error.message + "), retrying");
			await sleep(3_000);
		}
	}
}

async function loginOrSignup(client, email, password, log) {
	try {
		await client.login({ email, password, onlyLogin: true });
		return;
	} catch (error) {
		if (!/email_not_found|no_account|not_found/i.test(String(error.message))) throw error;
	}
	log("account missing, signing up " + email);
	await client.api.signupOrLogin({ email, password });
	await client.login({ email, password, onlyLogin: true });
}

async function ensureCharacter(client, name, log) {
	const characters = await client.characters().catch(() => null);
	if (!characters) return;
	const names = (characters || []).map((entry) => (entry.name || "").toLowerCase());
	if (names.includes(name.toLowerCase())) return;
	log("creating character " + name);
	await client.createCharacter({ name, char: "mage", look: 0 });
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

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const log = (line) => {
		if (!args.quiet) console.log(line);
	};

	const loop = await loadLoop(args.loop || DEFAULT_LOOP);
	log("loop: " + loop.path + " (" + (loop.run ? "run" : "decide") + (loop.meta.name ? ", " + loop.meta.name : "") + ")");

	const client = new ALClient({ apiBaseUrl: args.api });
	client.on("disconnected", (reason) => log("disconnected: " + (reason || "unknown")));

	log("logging in as " + args.character + " via " + args.api);
	await ensureAccount(client, args, log);
	await connectWithRetry(client, args, log);
	const entered = await client.enter(args.character);
	log("entered " + args.character + " at " + Math.round(entered.x) + "," + Math.round(entered.y) + " in " + entered.map);

	const started = Date.now();
	const windowMs = resolveRunWindow(args.seconds);
	const deadline = windowMs === Infinity ? Infinity : started + windowMs;
	const party = partyConfig(args);
	const counters = emptyCounters();
	const config = { sayText: DEFAULTS.sayText, ...(Number.isFinite(args.vendorAt) ? { vendorAt: args.vendorAt } : {}), party };

	client.on("event", (name, data) => {
		if (name === "hit" && data && String(data.hid).toLowerCase() === args.character.toLowerCase()) {
			counters.hits++;
			counters.damage += data.damage || 0;
		}
	});

	let stopping = false;
	const onSignal = () => {
		stopping = true;
		log("stopping on signal");
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const shouldStop = () => stopping || Date.now() >= deadline;
	if (deadline === Infinity) log("running until SIGTERM (seconds=0)");

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
			});
		} else {
			await decideLoop({ client, loop, args, log, counters, config, started, shouldStop });
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		try {
			client.disconnect();
		} catch {}
	}

	const elapsed = Math.round((Date.now() - started) / 1000);
	console.log(
		"ran " + elapsed + "s: " + counters.attacks + " attacks (" + counters.hits + " hits, " + Math.round(counters.damage) + " damage, " + counters.kills + " kills), " +
			counters.chests + " chests, " + counters.sold + " sold for " + counters.gold + " gold, " + counters.steps + " steps, " + counters.says + " says, " +
			counters.potions + " potions, " + counters.respawns + " respawns, " + counters.failures + " failures",
	);
	// Machine readable, so an e2e can assert on counters instead of parsing prose.
	console.log("summary " + JSON.stringify({ character: args.character, role: party.role, elapsed, counters }));
	return counters.failures > 0 && counters.attacks + counters.patrols === 0 ? 1 : 0;
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

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
	main().then(
		(code) => process.exit(code || 0),
		(error) => {
			console.error("bot failed: " + (error && error.message ? error.message : error));
			process.exit(1);
		},
	);
}
