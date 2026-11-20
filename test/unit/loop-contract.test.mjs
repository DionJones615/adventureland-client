import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadLoop } from "../../scripts/bot.mjs";

async function writeLoop(name, source) {
	const dir = await mkdtemp(path.join(tmpdir(), "al-loop-"));
	const file = path.join(dir, name);
	await writeFile(file, source);
	return file;
}

test("loads a decide() loop", async () => {
	const file = await writeLoop("pure.mjs", "export function decide() { return { type: 'idle' }; }\n");
	const loop = await loadLoop(file);
	assert.equal(typeof loop.decide, "function");
	assert.equal(loop.run, null);
});

test("loads a run() loop", async () => {
	const file = await writeLoop("full.mjs", "export async function run() {}\n");
	const loop = await loadLoop(file);
	assert.equal(loop.decide, null);
	assert.equal(typeof loop.run, "function");
});

test("rejects a module with neither contract", async () => {
	const file = await writeLoop("broken.mjs", "export const nothing = 1;\n");
	await assert.rejects(loadLoop(file), /neither decide\(state\) nor run\(context\)/);
});

test("rejects a missing file", async () => {
	await assert.rejects(loadLoop(path.join(tmpdir(), "does-not-exist-" + Date.now() + ".mjs")));
});

test("the bundled default loop satisfies the contract", async () => {
	const loop = await loadLoop(new URL("../../loops/basic.mjs", import.meta.url).pathname);
	assert.equal(typeof loop.decide, "function");
	assert.equal(loop.meta.name, "basic");
});

test("a decide loop gets the documented state and its action is executable", async () => {
	const file = await writeLoop(
		"state.mjs",
		"export function decide(state) { return { type: 'idle', until: state.now, seen: Object.keys(state).sort() }; }\n",
	);
	const loop = await loadLoop(file);
	const action = loop.decide({ self: null, monsters: [], drops: [], anchor: { x: 0, y: 0 }, step: 0, now: 1, nextSayAt: 0, attackReadyAt: 0, focus: null, avoid: new Set(), config: {} });
	assert.equal(action.type, "idle");
	for (const key of ["self", "monsters", "drops", "anchor", "step", "now", "nextSayAt", "attackReadyAt", "focus", "avoid", "config"]) {
		assert.ok(action.seen.includes(key), "state passed to the loop includes " + key);
	}
});
