#!/usr/bin/env node
// The bot runner CLI: one process, one character, one loop.
//
//   node scripts/bot.mjs --character Devmage --seconds 120
//   node scripts/bot.mjs --character Devmage --loop ./my-loops/aggressive.mjs
//   node scripts/bot.mjs --character PartyMerch --loop ./loops/party/merchant.mjs --seconds 0
//
// The plumbing lives in scripts/bot/runner.mjs, because a party is the same plumbing four times over
// with a single login (scripts/live/party.mjs). Loops are plain ES modules and can be mounted into the
// image, so a strategy never requires a rebuild:
//
//   docker run --rm --network al -v "$PWD/my-loops:/loops:ro" -e BOT_LOOP=/loops/aggressive.mjs ...
//
// A loop exports either decide(state) (pure: the runner executes the returned action) or
// run({client, log, counters, sleep, config}) (full control). See loops/README.md.

import { pathToFileURL } from "node:url";
import { ALClient } from "../client/index.mjs";
import { createPublisher } from "./bot/publish.mjs";
import {
	DEFAULT_EMAIL,
	DEFAULT_LOOP,
	DEFAULT_PASSWORD,
	LOCAL_API,
	bootClient,
	driveLoop,
	emptyCounters,
	isLocalApi,
	loadLoop,
	partyConfig,
	requireLiveAck,
	resolveRunWindow,
} from "./bot/runner.mjs";

// Re-exported so tests and the party launcher keep one obvious entry point.
export { emptyCounters, loadLoop, partyConfig, resolveRunWindow };

const off = (value) => value === "0" || value === "off" || value === "false";
const on = (value) => value === "1" || value === "on" || value === "true";

function parseArgs(argv) {
	const args = {
		character: process.env.AL_BOT_CHARACTER || "Devmage",
		seconds: Number(process.env.AL_BOT_SECONDS || 300),
		say: process.env.AL_BOT_SAY !== "0",
		transport: process.env.AL_BOT_TRANSPORT || "json",
		api: process.env.AL_API || process.env.AL_BOT_API || LOCAL_API,
		address: process.env.AL_GAME_ADDRESS || null,
		path: process.env.AL_GAME_PATH || null,
		server: process.env.AL_SERVER || null,
		live: on(process.env.AL_ALLOW_LIVE),
		publish: process.env.AL_PUBLISH || null,
		relayToken: process.env.AL_RELAY_TOKEN || null,
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
		targets: process.env.AL_PARTY_TARGETS || null,
		keepSell: process.env.AL_PARTY_KEEP || null,
		sendEnabled: !off(process.env.AL_PARTY_SEND),
		sellEnabled: !off(process.env.AL_PARTY_SELL),
		ownLoot: on(process.env.AL_PARTY_OWN_LOOT),
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
		else if (flag === "--path") args.path = next();
		else if (flag === "--server") args.server = next();
		else if (flag === "--live") args.live = true;
		else if (flag === "--publish") args.publish = next();
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
		else if (flag === "--party-targets") args.targets = next();
		else if (flag === "--party-keep") args.keepSell = next();
		else if (flag === "--party-no-send") args.sendEnabled = false;
		else if (flag === "--party-no-sell") args.sellEnabled = false;
		else if (flag === "--party-own-loot") args.ownLoot = true;
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
	"  --server <name>           game server to join, e.g. 'EU I' (env AL_SERVER); resolves its own path",
	"  --address <host:port>     game socket address override (env AL_GAME_ADDRESS); pair with --path",
	"  --live                    allow a non-local account API (the live game). Refused otherwise.",
	"  --publish <url>           post this client's world to the local relay (env AL_PUBLISH)",
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
	"  --party-targets <a,b>     only attack these monster types (env AL_PARTY_TARGETS)",
	"  --party-keep <a,b>        never sell these item names/patterns (env AL_PARTY_KEEP)",
	"  --party-no-send           never hand loot to the merchant (env AL_PARTY_SEND=off)",
	"  --party-no-sell           never sell anything (env AL_PARTY_SELL=off)",
	"  --party-own-loot          only open loot piles right after a party kill (env AL_PARTY_OWN_LOOT=1)",
	"  --no-say                  do not chat",
	"  --quiet, -q               only print the summary",
].join("\n");

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const log = (line) => {
		if (!args.quiet) console.log(line);
	};
	if (!requireLiveAck({ api: args.api, live: args.live, log })) return 2;
	if (!isLocalApi(args.api)) {
		log("LIVE: " + args.api + (args.server ? " server " + args.server : "") + " - party defaults are hold, no send, no sell");
	}

	const loop = await loadLoop(args.loop || DEFAULT_LOOP);
	log("loop: " + loop.path + " (" + (loop.run ? "run" : "decide") + (loop.meta.name ? ", " + loop.meta.name : "") + ")");

	const client = new ALClient({ apiBaseUrl: args.api });
	await bootClient({ args, log, client });

	const started = Date.now();
	const windowMs = resolveRunWindow(args.seconds);
	const deadline = windowMs === Infinity ? Infinity : started + windowMs;
	const counters = emptyCounters();
	if (deadline === Infinity) log("running until SIGTERM (seconds=0)");

	const publisher = args.publish
		? createPublisher(client, {
				url: args.publish,
				role: args.role,
				token: args.relayToken,
				getCounters: () => counters,
				onError: (message) => log("relay unreachable: " + message),
		  })
		: null;
	publisher?.start();
	if (publisher) log("publishing to " + publisher.endpoint + " as " + publisher.source);

	let stopping = false;
	const onSignal = () => {
		stopping = true;
		log("stopping on signal");
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const shouldStop = () => stopping || Date.now() >= deadline;

	try {
		await driveLoop({
			client,
			loop,
			args,
			log,
			counters,
			started,
			deadline,
			shouldStop,
			publish: publisher,
			onSummary: (line, value, meta) => {
				if (!args.quiet || (meta && meta.raw)) console.log(line);
			},
		});
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		publisher?.stop();
	}

	return counters.failures > 0 && counters.attacks + counters.patrols === 0 ? 1 : 0;
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
