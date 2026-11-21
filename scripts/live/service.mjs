#!/usr/bin/env node
// Keep the party up: supervise the relay and the party process.
//
//   node scripts/live/service.mjs --env examples/live-party/live.env --live
//   node scripts/live/service.mjs --status
//
// A party process can die for reasons the loops cannot fix themselves - a dropped socket, a session
// the server closed, an exception in one client. Rather than a bot loop that silently stops, this
// starts the party as a child, watches the relay's view of the world, and restarts the whole party
// when it stops publishing or exits.
//
// What it cannot fix: the game's own rule for accounts that run 24/7 (see the README). That is a
// decision for the account owner, not something a supervisor should paper over.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, buildPlan, parseEnvFile } from "./party.mjs";

export const SERVICE_DEFAULTS = {
	healthMs: 30_000,
	// How long the party may look dead in the relay before the supervisor replaces the process.
	staleAfterMs: 120_000,
	restartDelays: [5_000, 15_000, 60_000, 300_000],
	logMaxBytes: 5 * 1024 * 1024,
	logKeep: 3,
	stateDir: path.join(os.homedir(), ".local", "state", "adventureland-party"),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential-ish backoff with a ceiling: a flapping party must not hammer the login. */
export function nextBackoff(attempt, delays = SERVICE_DEFAULTS.restartDelays) {
	if (!delays.length) return 0;
	return delays[Math.min(Math.max(0, attempt), delays.length - 1)];
}

/** Every wanted character has a fresh snapshot in the relay? */
export function partyHealthy(health, names) {
	if (!health || !Array.isArray(health.sources) || !names || !names.length) return false;
	const fresh = new Set(health.sources.filter((entry) => entry && !entry.stale).map((entry) => String(entry.name).toLowerCase()));
	return names.every((name) => fresh.has(String(name).toLowerCase()));
}

/** Redirect the log when it grows past the cap; keeps the current file plus N rotations. */
export function rotateLog(logPath, { maxBytes = SERVICE_DEFAULTS.logMaxBytes, keep = SERVICE_DEFAULTS.logKeep } = {}) {
	try {
		if (!fs.statSync(logPath).size || fs.statSync(logPath).size < maxBytes) return false;
	} catch {
		return false;
	}
	for (let index = keep; index >= 1; index--) {
		const from = index === 1 ? logPath : logPath + "." + (index - 1);
		const to = logPath + "." + index;
		try {
			if (index === keep) fs.rmSync(to, { force: true });
			if (fs.existsSync(from)) fs.renameSync(from, to);
		} catch {}
	}
	return true;
}

/** The party flags for the child: no time limit, and deaths never end the run. */
export function childArgs(argv) {
	const out = [];
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--seconds" || flag === "--max-deaths") {
			index++;
			continue;
		}
		if (flag === "--status" || flag === "--once" || flag === "--supervise") continue;
		out.push(flag);
	}
	out.push("--seconds", "0", "--max-deaths", "-1");
	return out;
}

function relayPort(url) {
	try {
		return Number(new URL(String(url)).port) || 7899;
	} catch {
		return 7899;
	}
}

function parseArgs(argv) {
	const args = { env: process.env.AL_PARTY_ENV_FILE || "examples/live-party/live.env", log: null, status: false, once: false, relay: true };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const next = () => argv[++index];
		if (flag === "--env") args.env = next();
		else if (flag === "--log") args.log = next();
		else if (flag === "--status") args.status = true;
		else if (flag === "--once") args.once = true;
		else if (flag === "--no-relay") args.relay = false;
		else if (flag === "--help" || flag === "-h") args.help = true;
	}
	return args;
}

async function relayHealth(url) {
	try {
		const response = await fetch(String(url).replace(/[/]+$/, "") + "/health", { signal: AbortSignal.timeout(4000) });
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}

function readState(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
	} catch {
		return null;
	}
}

function writeState(dir, value) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(value, null, 2));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const stateDir = SERVICE_DEFAULTS.stateDir;
	if (args.help) {
		console.log("usage: node scripts/live/service.mjs [--env <file>] [--live] [--log <file>] [--status] [--once] [--no-relay]");
		return 0;
	}
	const envPath = path.resolve(ROOT, args.env);
	const env = fs.existsSync(envPath) ? parseEnvFile(fs.readFileSync(envPath, "utf8")) : {};
	const plan = buildPlan({ args: {}, env });
	if (!plan.publish) {
		console.error("[service] the relay URL is required: set AL_PUBLISH in the env file");
		return 2;
	}
	const logPath = path.resolve(args.log || process.env.AL_PARTY_LOG || path.join(stateDir, "party.log"));
	const log = (line) => {
		const text = new Date().toISOString() + " [service] " + line + String.fromCharCode(10);
		process.stdout.write(text);
		try {
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, text);
		} catch {}
	};

	if (args.status) {
		const state = readState(stateDir);
		const health = await relayHealth(plan.publish);
		console.log(JSON.stringify({ state, relay: health, log: logPath }, null, 1));
		return 0;
	}

	let stopping = false;
	let child = null;
	let attempt = 0;
	let lastHealthyAt = 0;
	const state = { startedAt: new Date().toISOString(), restarts: 0, characters: plan.members, log: logPath };
	log("supervising " + plan.members.join(", ") + " on " + plan.api + (plan.server ? " server " + plan.server : ""));

	const stop = (signal) => {
		log("stopping (" + signal + ")");
		stopping = true;
		if (child) child.kill("SIGTERM");
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));

	while (!stopping) {
		// The relay is the window into the party: keep it alive too.
		let health = await relayHealth(plan.publish);
		if (!health && args.relay) {
			log("relay not answering, starting it");
			const relay = spawn(process.execPath, [path.join(ROOT, "scripts/live/relay.mjs"), "--port", String(relayPort(plan.publish))], { cwd: ROOT, env: process.env, stdio: "ignore", detached: true });
			relay.unref();
			for (let wait = 0; wait < 40; wait++) {
				health = await relayHealth(plan.publish);
				if (health) break;
				await sleep(500);
			}
		}
		if (!health) {
			log("relay is still down - retrying in 15s");
			await sleep(15_000);
			continue;
		}

		rotateLog(logPath);
		const fd = fs.openSync(logPath, "a");
		state.restarts = attempt;
		state.childStartedAt = new Date().toISOString();
		state.child = childArgs(process.argv.slice(2)).join(" ");
		writeState(stateDir, state);
		child = spawn(process.execPath, [path.join(ROOT, "scripts/live/party.mjs"), ...childArgs(process.argv.slice(2))], { cwd: ROOT, env: process.env, stdio: ["ignore", fd, fd] });
		fs.closeSync(fd);
		log("party started (pid " + child.pid + ")");
		lastHealthyAt = Date.now();

		const watchdog = setInterval(async () => {
			if (stopping || !child) return;
			const current = await relayHealth(plan.publish);
			if (partyHealthy(current, plan.members)) {
				lastHealthyAt = Date.now();
				return;
			}
			if (Date.now() - lastHealthyAt > SERVICE_DEFAULTS.staleAfterMs) {
				log("the party has not published for " + Math.round((Date.now() - lastHealthyAt) / 1000) + "s - restarting it");
				child.kill("SIGTERM");
			}
		}, SERVICE_DEFAULTS.healthMs);
		watchdog.unref?.();

		const code = await new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })));
		clearInterval(watchdog);
		child = null;
		if (stopping) break;
		log("party exited (" + JSON.stringify(code) + ")");
		if (args.once) break;
		attempt = Date.now() - lastHealthyAt > 10 * 60_000 ? 0 : attempt + 1;
		const wait = nextBackoff(attempt - 1);
		log("restarting in " + Math.round(wait / 1000) + "s (attempt " + attempt + ")");
		await sleep(wait);
	}

	state.stoppedAt = new Date().toISOString();
	writeState(stateDir, state);
	log("stopped");
	return 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
	main().then(
		(code) => process.exit(code || 0),
		(error) => {
			console.error("[service] failed: " + (error && error.message ? error.message : error));
			process.exit(1);
		},
	);
}
