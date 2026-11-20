// Game definitions (G) for the client: items, monsters, maps, geometry, skills.
//
// The corpus already stores the live data.js verbatim. Parsing it here (instead of importing a JSON
// dump) keeps the client byte-identical with what the game ships, and lets a caller point at a
// different snapshot - for example the copy the local server serves at /data.js.

import fs from "node:fs";
import vm from "node:vm";

const DEFAULT_FILE = new URL("../reference/game-data/raw/data.js", import.meta.url);

/** @returns {Record<string, any>} the G object */
export function parseGameData(source, { filename = "data.js" } = {}) {
	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename, timeout: 60_000 });
	const G = sandbox.G;
	if (!G || typeof G !== "object") throw new Error("data.js did not define G");
	return G;
}

let cached = null;

export function loadGameData(file = DEFAULT_FILE) {
	if (cached && cached.file === String(file)) return cached.G;
	const source = fs.readFileSync(file, "utf8");
	const G = parseGameData(source, { filename: String(file) });
	cached = { file: String(file), G };
	return G;
}
