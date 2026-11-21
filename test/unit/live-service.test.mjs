import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { childArgs, nextBackoff, partyHealthy, rotateLog } from "../../scripts/live/service.mjs";

test("the restart delay grows and then stays at the ceiling", () => {
	assert.deepEqual([0, 1, 2, 3, 4, 9].map((attempt) => nextBackoff(attempt)), [5000, 15000, 60000, 300000, 300000, 300000]);
	assert.deepEqual(nextBackoff(3, [1000]), [1000][0]);
});

test("the party is healthy only when every character publishes a fresh snapshot", () => {
	const fresh = { sources: [{ name: "Dion6" }, { name: "MAION" }, { name: "Paion" }, { name: "DionMerchant" }] };
	assert.equal(partyHealthy(fresh, ["Dion6", "Maion", "Paion", "DionMerchant"]), true);
	assert.equal(partyHealthy(fresh, ["Dion6", "Nobody"]), false, "a missing character is not healthy");
	assert.equal(partyHealthy({ sources: [{ name: "Dion6", stale: true }] }, ["Dion6"]), false, "a stale source is not healthy");
	assert.equal(partyHealthy(null, ["Dion6"]), false);
	assert.equal(partyHealthy(fresh, []), false);
});

test("the child runs without a time limit and without a death cap", () => {
	const args = childArgs(["--env", "examples/live-party/live.env", "--live", "--seconds", "300", "--max-deaths", "3", "--no-sell"]);
	assert.deepEqual(args, ["--env", "examples/live-party/live.env", "--live", "--no-sell", "--seconds", "0", "--max-deaths", "-1"]);
});

test("the log is rotated and the oldest copy is dropped", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-service-"));
	const log = path.join(dir, "party.log");
	fs.writeFileSync(log, "x".repeat(64));
	assert.equal(rotateLog(log, { maxBytes: 1024, keep: 3 }), false, "a small log is left alone");
	fs.writeFileSync(log, "y".repeat(2048));
	assert.equal(rotateLog(log, { maxBytes: 1024, keep: 2 }), true);
	assert.equal(fs.existsSync(log), false, "the live log moved aside");
	assert.equal(fs.existsSync(log + ".1"), true);
	fs.rmSync(dir, { recursive: true, force: true });
});
