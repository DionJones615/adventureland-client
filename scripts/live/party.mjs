#!/usr/bin/env node
// A whole party in one process: one login, four game sockets, four loops, one watch page.
//
//   node scripts/live/party.mjs --env examples/live-party/local.env --api http://127.0.0.1:18090
//   node scripts/live/party.mjs --env examples/live-party/live.env --live --seconds 300
//
// Why one process and one login: four independent logins look like four sessions to the account
// backend, and the last one may invalidate the others. Here the first client logs in, the other three
// share that session, and every character keeps its own socket.
//
// The live profile is deliberately timid: --hold runs the party handshake and nothing else, and the
// env file turns sending and selling off, allowlists the monsters and claims only our own loot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALClient } from "../../client/index.mjs";
import { createPublisher } from "../bot/publish.mjs";
import { LOCAL_API, bootClient, driveLoop, emptyCounters, isLocalApi, loadLoop, requireLiveAck, resolveRunWindow, sleep } from "../bot/runner.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const ROLES = {
	leader: "loops/party/leader.mjs",
	fighter: "loops/party/fighter.mjs",
	priest: "loops/party/priest.mjs",
	merchant: "loops/party/merchant.mjs",
	hold: "loops/party/hold.mjs",
};

const NEWLINE = String.fromCharCode(10);
const off = (value) => value === "0" || value === "off" || value === "false";
const on = (value) => value === "1" || value === "on" || value === "true";
// The same rule the runner uses: a loopback/private address or a compose service name is a local
// stack, not a character on a real account.
const isLocal = isLocalApi;

/** A KEY=VALUE file: # comments, optional export/quoting. No interpolation on purpose. */
export function parseEnvFile(text) {
	const out = {};
	for (const raw of String(text || "").split(NEWLINE)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
		const at = withoutExport.indexOf("=");
		if (at <= 0) continue;
		const key = withoutExport.slice(0, at).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = withoutExport.slice(at + 1).trim();
		if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/** "Tank=leader,Mage=fighter" -> [{ name: "Tank", role: "leader" }, ...] */
export function parseRoles(text) {
	const out = [];
	for (const part of String(text || "").split(",")) {
		const item = part.trim();
		if (!item) continue;
		const at = item.indexOf("=");
		const name = (at >= 0 ? item.slice(0, at) : item).trim();
		const role = (at >= 0 ? item.slice(at + 1) : "fighter").trim().toLowerCase();
		if (name) out.push({ name, role: role || "fighter" });
	}
	return out;
}

const pick = (args, env, flagKey, envKey, fallback = null) => {
	if (args[flagKey] !== undefined && args[flagKey] !== null) return args[flagKey];
	if (env[envKey] !== undefined && env[envKey] !== "") return env[envKey];
	return fallback;
};

/** Everything the run needs, validated, from flags and the env file. Throws on a plan that cannot run. */
export function buildPlan({ args = {}, env = {} } = {}) {
	const api = pick(args, env, "api", "AL_API", LOCAL_API);
	const server = pick(args, env, "server", "AL_SERVER", null);
	const live = args.live === true || on(env.AL_ALLOW_LIVE);
	const roles = parseRoles(pick(args, env, "roles", "AL_PARTY_ROLES", ""));
	if (!roles.length) throw new Error("no characters: pass --roles Name=role,... or AL_PARTY_ROLES");
	for (const entry of roles) {
		if (!ROLES[entry.role]) throw new Error("unknown role " + entry.role + " for " + entry.name + " (have " + Object.keys(ROLES).join(", ") + ")");
	}
	if (!isLocal(api) && !server) throw new Error("a remote account API needs --server: every character has to play on the same server");
	const hold = args.hold === true || on(env.AL_PARTY_HOLD);
	const leader = (roles.find((entry) => entry.role === "leader") || roles[0]).name;
	const merchant = (roles.find((entry) => entry.role === "merchant") || {}).name || pick(args, env, "partyMerchant", "AL_PARTY_MERCHANT", null);
	return {
		api,
		address: pick(args, env, "address", "AL_GAME_ADDRESS", null),
		server,
		live,
		email: pick(args, env, "email", "AL_USERNAME", process.env.AL_USERNAME || pick(args, env, "email", "AL_BOT_EMAIL", null)),
		password: pick(args, env, "password", "AL_PASSWORD", process.env.AL_PASSWORD || pick(args, env, "password", "AL_BOT_PASSWORD", null)),
		roles,
		hold,
		leader,
		members: roles.map((entry) => entry.name),
		merchant,
		anchor: pick(args, env, "anchor", "AL_PARTY_ANCHOR", null),
		sellAt: pick(args, env, "sellAt", "AL_PARTY_SELL_AT", null),
		targets: pick(args, env, "targets", "AL_PARTY_TARGETS", ""),
		keepSell: pick(args, env, "keepSell", "AL_PARTY_KEEP", ""),
		sendEnabled: !(off(pick(args, env, "send", "AL_PARTY_SEND", "on")) || args.sendEnabled === false),
		sellEnabled: !(off(pick(args, env, "sell", "AL_PARTY_SELL", "on")) || args.sellEnabled === false),
		ownLoot: args.ownLoot === true || on(pick(args, env, "ownLoot", "AL_PARTY_OWN_LOOT", "off")),
		// A respawn count, not a timer: a party that keeps dying is a problem, not a run.
		maxDeaths: Number(pick(args, env, "maxDeaths", "AL_PARTY_MAX_DEATHS", 5)),
		seconds: Number(pick(args, env, "seconds", "AL_PARTY_SECONDS", 0)),
		publish: pick(args, env, "publish", "AL_PUBLISH", null),
		transport: pick(args, env, "transport", "AL_BOT_TRANSPORT", "json"),
	};
}

function parseArgs(argv) {
	const args = { env: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(flag + " needs a value");
			return argv[++i];
		};
		if (flag === "--env") args.env = next();
		else if (flag === "--api") args.api = next();
		else if (flag === "--server") args.server = next();
		else if (flag === "--address") args.address = next();
		else if (flag === "--live") args.live = true;
		else if (flag === "--hold") args.hold = true;
		else if (flag === "--roles") args.roles = next();
		else if (flag === "--role") args.roles = next();
		else if (flag === "--email") args.email = next();
		else if (flag === "--password") args.password = next();
		else if (flag === "--anchor") args.anchor = next();
		else if (flag === "--sell-at") args.sellAt = next();
		else if (flag === "--targets") args.targets = next();
		else if (flag === "--keep") args.keepSell = next();
		else if (flag === "--publish") args.publish = next();
		else if (flag === "--seconds") args.seconds = next();
		else if (flag === "--max-deaths") args.maxDeaths = next();
		else if (flag === "--transport") args.transport = next();
		else if (flag === "--no-send") args.sendEnabled = false;
		else if (flag === "--no-sell") args.sellEnabled = false;
		else if (flag === "--own-loot") args.ownLoot = true;
		else if (flag === "--help" || flag === "-h") args.help = true;
		else throw new Error("unknown flag: " + flag);
	}
	return args;
}

const USAGE = [
	"usage: node scripts/live/party.mjs --env <file> [options]",
	"",
	"  --env <file>       KEY=VALUE file (AL_USERNAME, AL_PASSWORD, AL_SERVER, AL_PARTY_ROLES, ...)",
	"  --api <url>        account API (default http://127.0.0.1:8090)",
	"  --server <name>    game server, e.g. 'EU I' (required for a remote API)",
	"  --address <host:port>  override the advertised game socket (env AL_GAME_ADDRESS)",
	"  --live             confirm a remote account API (the live game)",
	"  --hold             every character joins the party and stands still",
	"  --roles <list>     Name=role pairs: leader/fighter/priest/merchant/hold",
	"  --anchor <x,y>     where the party fights",
	"  --targets <a,b>    only attack these monster types",
	"  --keep <a,b>       never sell these item names/patterns",
	"  --no-send          never hand loot to the merchant",
	"  --no-sell          never sell anything",
	"  --own-loot         only open loot piles right after one of our own kills",
	"  --publish <url>    post every client's world to the local relay",
	"  --seconds <n>      run window; 0 runs until SIGTERM (default 0)",
	"  --max-deaths <n>   stop the whole party after this many respawns (default 5)",
].join(NEWLINE);

/** The per-client args object driveLoop and partyConfig expect. */
export function clientArgs(plan, entry) {
	return {
		character: entry.name,
		role: plan.hold ? "hold" : entry.role,
		api: plan.api,
		server: plan.server || null,
		address: plan.address || null,
		path: plan.address ? "/socket.io/" : undefined,
		transport: plan.transport,
		say: false,
		leader: plan.leader,
		members: plan.members.join(","),
		partyMerchant: plan.merchant,
		anchor: plan.anchor,
		sellAt: plan.sellAt,
		sendAt: null,
		sellAtFill: null,
		healBelow: null,
		targets: plan.targets,
		keepSell: plan.keepSell,
		sendEnabled: plan.sendEnabled,
		sellEnabled: plan.sellEnabled,
		ownLoot: plan.ownLoot,
		vendorAt: null,
		merchant: null,
		live: plan.live,
	};
}

function pad(value, width) {
	const text = String(value === undefined || value === null ? "?" : value);
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * Run the whole plan. Returns the exit code. Publishers are created here, so a relay that is not
 * running costs nothing but a log line.
 */
export async function runParty({ plan, log = (line) => console.log(line), loopPaths = ROLES, onPublisher = null } = {}) {
	if (!plan) throw new Error("runParty needs a plan");
	log("[party] " + plan.roles.length + " characters on " + plan.api + (plan.server ? " server " + plan.server : "") + (plan.hold ? " (hold)" : ""));
	const first = new ALClient({ apiBaseUrl: plan.api });
	await first.login({ email: plan.email, password: plan.password, onlyLogin: true });
	const characters = await first.characters();
	const byName = new Map((characters || []).map((entry) => [String(entry.name).toLowerCase(), entry]));
	for (const entry of plan.roles) {
		const known = byName.get(entry.name.toLowerCase());
		if (!known) throw new Error("character " + entry.name + " is not on this account");
		if (known.secret) throw new Error("character " + entry.name + " is already online; log it out first");
		log("[party] " + pad(entry.name, 14) + pad(entry.role, 9) + " lvl " + pad(known.level, 3) + " " + pad(known.map, 12) + " " + Math.round(known.x || 0) + "," + Math.round(known.y || 0));
	}
	if (plan.server) {
		const servers = await first.servers();
		const wanted = String(plan.server).toLowerCase();
		const found = (servers || []).find((entry) => (entry.region + " " + entry.name).toLowerCase() === wanted || String(entry.name).toLowerCase() === wanted);
		if (!found) throw new Error("no server named " + plan.server + " (have " + (servers || []).map((entry) => entry.region + " " + entry.name).join(", ") + ")");
		log("[party] server " + found.region + " " + found.name + " at " + found.address + (found.path || ""));
	}

	const started = Date.now();
	const windowMs = resolveRunWindow(plan.seconds);
	const deadline = windowMs === Infinity ? Infinity : started + windowMs;
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	const onSignal = () => {
		log("[party] signal: stopping every character");
		stop();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const jobs = [];
	const publishers = [];
	try {
		for (const [index, entry] of plan.roles.entries()) {
			if (index > 0) await sleep(2000);
			if (stopping) break;
			const client = new ALClient({ apiBaseUrl: plan.api });
			const args = clientArgs(plan, entry);
			const prefix = "[" + entry.name + "] ";
			log("[party] starting " + entry.name);
			await bootClient({ args, log: (line) => log(prefix + line), client, session: first.session, cookies: first.api.cookies });
			const counters = emptyCounters();
			const loopPath = path.resolve(ROOT, loopPaths[args.role] || loopPaths.fighter);
			const loop = await loadLoop(loopPath);
			const publisher = plan.publish
				? createPublisher(client, { url: plan.publish, role: args.role, getCounters: () => counters, onError: (message) => log(prefix + "relay unreachable: " + message) })
				: null;
			if (publisher) {
				publisher.start();
				publishers.push(publisher);
				if (typeof onPublisher === "function") onPublisher(publisher, entry);
				log(prefix + "publishing to " + publisher.endpoint);
			}
			const job = {
				entry,
				counters,
				promise: driveLoop({
					client,
					loop,
					args,
					log: (line) => log(prefix + line),
					counters,
					started,
					deadline,
					shouldStop: () => stopping || Date.now() >= deadline,
					publish: publisher,
					onSummary: (line) => log(prefix + line),
				}).catch((error) => {
					log(prefix + "stopped with an error: " + (error && error.message ? error.message : error));
					counters.failures++;
				}),
			};
			jobs.push(job);
		}
		if (!jobs.length) throw new Error("no character started");
		// A party that keeps dying is a problem, not a run: watch the respawn counts while the loops run.
		const watchdog = setInterval(() => {
			const deaths = jobs.reduce((sum, job) => sum + (job.counters.respawns || 0), 0);
			if (deaths > Math.max(0, plan.maxDeaths)) {
				log("[party] " + deaths + " respawns, stopping (--max-deaths " + plan.maxDeaths + ")");
				stop();
			}
		}, 2000);
		watchdog.unref?.();
		await Promise.all(jobs.map((job) => job.promise));
		clearInterval(watchdog);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		for (const publisher of publishers) publisher.stop();
	}
	const total = jobs.reduce(
		(sum, job) => {
			for (const [key, value] of Object.entries(job.counters)) sum[key] = (sum[key] || 0) + value;
			return sum;
		},
		{},
	);
	log("[party] every character is offline again: " + JSON.stringify(total));
	log("party-summary " + JSON.stringify({ characters: jobs.map((job) => job.entry.name), seconds: Math.round((Date.now() - started) / 1000), totals: total }));
	return 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const envPath = path.resolve(ROOT, args.env || process.env.AL_PARTY_ENV_FILE || "examples/live-party/live.env");
	let env = {};
	if (fs.existsSync(envPath)) {
		env = parseEnvFile(fs.readFileSync(envPath, "utf8"));
		console.log("[party] env " + envPath);
	} else {
		console.log("[party] no env file at " + envPath + ", using the environment only");
	}
	const plan = buildPlan({ args, env });
	const gateLog = (line) => console.log("[party] " + line);
	if (!requireLiveAck({ api: plan.api, live: plan.live, log: gateLog })) process.exit(2);
	if (!plan.email || !plan.password) {
		console.error("[party] no credentials: set AL_USERNAME/AL_PASSWORD in the env file or pass --email/--password");
		process.exit(2);
	}
	runParty({ plan }).then(
		(code) => process.exit(code || 0),
		(error) => {
			console.error("[party] failed: " + (error && error.message ? error.message : error));
			process.exit(1);
		},
	);
}
