#!/usr/bin/env node
// Run the published game image for e2e tests.
//
//   npm run e2e:up     # pull (if missing), start, wait until the fixtures are seeded
//   npm run e2e:down
//
// The image is pulled, never built: this repo tests a *client* against a released *server*. Override
// with AL_IMAGE (pin a :sha-<short> tag for reproducible runs) and AL_CONTAINER_BIN (docker/podman).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NAME = process.env.AL_E2E_NAME || "al-e2e-game";
const DEFAULT_IMAGE = "ghcr.io/dionjones615/adventureland-container:latest";

function engine() {
	if (process.env.AL_CONTAINER_BIN) return process.env.AL_CONTAINER_BIN;
	for (const candidate of ["docker", "podman"]) {
		if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
	}
	throw new Error("neither docker nor podman is installed (or set AL_CONTAINER_BIN)");
}

const BIN = engine();
const command = process.argv[2] || "up";
const args = process.argv.slice(3);
const value = (name, fallback) => {
	const index = args.indexOf("--" + name);
	return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};

const image = value("image", process.env.AL_IMAGE || DEFAULT_IMAGE);
const apiPort = value("api-port", process.env.AL_E2E_API_PORT || "18090");
const gamePort = value("game-port", process.env.AL_E2E_GAME_PORT || "17192");
const clone = path.resolve(value("clone", process.env.AL_E2E_CLONE || path.join(ROOT, ".e2e-clone")));
const fixtures = path.resolve(value("fixtures", path.join(ROOT, "test/e2e/fixtures/client-e2e.json")));

function run(argv, { quiet = false, inherit = false } = {}) {
	return new Promise((resolve, reject) => {
		if (!quiet) console.log("[" + BIN + "] " + argv.join(" "));
		const child = spawn(BIN, argv, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout?.on("data", (chunk) => (out += chunk));
		child.stderr?.on("data", (chunk) => (out += chunk));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(argv[0] + " -> exit " + code + "\n" + out))));
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function up() {
	await fs.mkdir(clone, { recursive: true });
	// Start from a clean database: the fixtures are applied at container start, so a database left
	// over from a previous run (characters moved, items sold) would make the assertions meaningless.
	// node_modules and the clone survive - only the mutable state goes.
	await fs.rm(path.join(clone, ".data"), { recursive: true, force: true });
	await fs.rm(path.join(clone, ".state"), { recursive: true, force: true });
	const exists = await run(["image", "inspect", image], { quiet: true }).then(() => true).catch(() => false);
	if (!exists) {
		console.log("[e2e] pulling " + image);
		await run(["pull", image]);
	} else {
		console.log("[e2e] image present locally: " + image);
	}
	await run(["rm", "-f", NAME], { quiet: true }).catch(() => {});

	await run([
		"run", "-d", "--name", NAME,
		"-p", apiPort + ":8090",
		"-p", gamePort + ":7192",
		"-e", "DEFAULT_EMAIL=" + (process.env.AL_E2E_EMAIL || "dev@example.test"),
		"-e", "DEFAULT_PASSWORD=" + (process.env.AL_E2E_PASSWORD || "dev-password-123"),
		"-e", "SEED_FIXTURES=/app/fixtures/" + path.basename(fixtures),
		"-v", path.dirname(fixtures) + ":/app/fixtures:ro,z",
		"-v", clone + ":/app/reference/local:z",
		image,
	]);

	const marker = path.join(clone, ".state", "fixtures.ready");
	const api = "http://127.0.0.1:" + apiPort;
	console.log("[e2e] waiting for " + api + " and the fixtures");
	let apiReady = false;
	for (let attempt = 1; attempt <= 150; attempt++) {
		if (!apiReady) {
			try {
				const response = await fetch(api + "/api/signup_or_login", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ email: process.env.AL_E2E_EMAIL || "dev@example.test", password: process.env.AL_E2E_PASSWORD || "dev-password-123" }),
				});
				const body = await response.json().catch(() => null);
				apiReady = Boolean(body && body.success);
			} catch {}
		}
		const ready = await fs.stat(marker).catch(() => null);
		if (apiReady && ready) {
			const content = JSON.parse(await fs.readFile(marker, "utf8"));
			if (content.failures) throw new Error("the fixture seeder reported " + content.failures + " failure(s) - see " + (await run(["logs", NAME], { quiet: true })).slice(-3000));
			console.log("[e2e] ready: api " + api + ", game 127.0.0.1:" + gamePort);
			// The server advertises localhost:<internal port>; on the host the published port is
			// different, so the tests need the explicit game-socket address.
			console.log("AL_E2E_API=" + api);
			console.log("AL_E2E_ADDRESS=127.0.0.1:" + gamePort);
			return;
		}
		await sleep(4_000);
	}
	throw new Error("the stack never became ready\n" + (await run(["logs", NAME], { quiet: true })).slice(-3000));
}

async function down() {
	await run(["rm", "-f", NAME]).catch((error) => console.log("[e2e] " + error.message));
}

const commands = {
	up,
	down,
	status: async () => console.log(await run(["ps", "--filter", "name=" + NAME, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"], { quiet: true })),
	logs: async () => run(["logs", NAME, ...(args.includes("-f") ? ["-f"] : [])], { inherit: true }),
	image: async () => console.log(image),
};

if (!commands[command]) {
	console.log("usage: node scripts/e2e/container.mjs up|down|status|logs [--image <ref>] [--api-port 18090] [--game-port 17192]");
	process.exit(1);
}
commands[command]().catch((error) => {
	console.error("[e2e] " + error.message);
	process.exit(1);
});
