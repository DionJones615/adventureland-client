#!/usr/bin/env node
// Fetch the one upstream file the codec tests diff against.
//
// test/unit/msgpack-parser.test.mjs encodes with our parser and decodes with the game's, so it needs
// the browser client's minified parser at the pinned commit. It is fetched rather than committed:
// it belongs to the game, which we do not redistribute. The test skips cleanly when it is absent.

import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "reference", "upstream", "socket.io-msgpack-parser.min.cjs");
const COMMIT = process.env.AL_GAME_SHA || "a5c133dcc31f97edab987119517b4a60581248f6";
const URL_SOURCE =
	process.env.AL_MSGPACK_PARSER_URL ||
	"https://raw.githubusercontent.com/kaansoral/adventureland_mongodb/" + COMMIT + "/js/socket.io-msgpack-parser.min.js";

if (await stat(OUT).catch(() => null)) {
	console.log("[fetch-reference] already present: " + OUT);
	process.exit(0);
}

console.log("[fetch-reference] GET " + URL_SOURCE);
const response = await fetch(URL_SOURCE);
if (!response.ok) {
	console.error("[fetch-reference] HTTP " + response.status + " - the differential test will be skipped");
	process.exit(0);
}
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, Buffer.from(await response.arrayBuffer()));
console.log("[fetch-reference] wrote " + OUT);
