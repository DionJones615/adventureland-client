import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestQueue } from "../../client/queue.mjs";
import { DisconnectedError, TimeoutError } from "../../client/errors.mjs";

test("a request is registered before it is sent, so a fast answer is not lost", async () => {
	const sent = [];
	const queue = new RequestQueue({
		send: (event, data) => {
			sent.push(event);
			// The server answers synchronously: the pending entry must already exist.
			queue.settle("game_response", { place: event, response: "data" });
		},
	});
	const answer = await queue.push("say", { message: "hi" });
	assert.deepEqual(answer, { place: "say", response: "data" });
	assert.deepEqual(sent, ["say"]);
});

test("answers are matched to the event that asked, not to whichever is pending", async () => {
	const queue = new RequestQueue({ send: () => {} });
	const attack = queue.push("attack", { id: "42" }, { timeoutMs: 500 });
	const use = queue.push("use", { item: "hp" }, { timeoutMs: 500 });
	queue.settle("game_response", { place: "use", response: "data" });
	assert.deepEqual((await use).place, "use");
	let attackSettled = false;
	attack.then(() => (attackSettled = true), () => (attackSettled = true));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(attackSettled, false);
	queue.settle("game_response", { place: "attack", response: "fail" });
	assert.equal((await attack).response, "fail");
});

test("timeouts reject with TimeoutError and clean up", async () => {
	const queue = new RequestQueue({ send: () => {} });
	await assert.rejects(queue.push("move", {}, { timeoutMs: 20 }), TimeoutError);
	assert.equal(queue.size, 0);
});

test("fail() rejects everything in flight on disconnect", async () => {
	const queue = new RequestQueue({ send: () => {} });
	const pending = queue.push("say", {}, { timeoutMs: 5000 });
	queue.fail("disconnected");
	await assert.rejects(pending, DisconnectedError);
	assert.equal(queue.size, 0);
});

test("rate limiting spaces sends per event", async () => {
	const timestamps = [];
	const queue = new RequestQueue({ send: () => timestamps.push(Date.now()), intervals: { say: 80, default: 1 } });
	const one = queue.push("say", {}, { timeoutMs: 1000 }).catch(() => {});
	const two = queue.push("say", {}, { timeoutMs: 1000 }).catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 200));
	await Promise.all([one, two]);
	assert.equal(timestamps.length, 2);
	assert.ok(timestamps[1] - timestamps[0] >= 70, "second send waited for the interval");
});
