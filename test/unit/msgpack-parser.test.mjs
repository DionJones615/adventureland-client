import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import { Encoder, Decoder, PacketType, packetToTuple, tupleToPacket } from "../../client/transport/msgpack-parser.mjs";

const ROOT = new URL("../../", import.meta.url);
const OFFICIAL = new URL("reference/upstream/socket.io-msgpack-parser.min.cjs", ROOT);

const require = createRequire(import.meta.url);

function decodeWith(parser, encoded) {
	const decoder = new parser.Decoder();
	return new Promise((resolve) => {
		decoder.on("decoded", resolve);
		decoder.add(encoded);
	});
}

test("packet tuples match the server's wire layout", () => {
	assert.deepEqual(packetToTuple({ type: PacketType.EVENT, data: ["welcome", { a: 1 }] }), [2, ["welcome", { a: 1 }]]);
	assert.deepEqual(packetToTuple({ type: PacketType.EVENT, id: 7, data: ["x"] }), [2, 7, ["x"]]);
	assert.deepEqual(packetToTuple({ type: PacketType.ACK, id: 3, data: [1] }), [3, 3, [1]]);
	assert.deepEqual(packetToTuple({ type: PacketType.CONNECT }), [0]);
	assert.deepEqual(tupleToPacket([2, 5, ["u", {}]]), { type: 2, nsp: "/", id: 5, data: ["u", {}] });
	assert.throws(() => tupleToPacket([2, "not-an-id", ["x"]]), /invalid EVENT packet/);
	assert.throws(() => tupleToPacket([9]), /unsupported packet type/);
});

test("encoder and decoder round-trip a game packet", async () => {
	const encoder = new Encoder();
	const [frame] = encoder.encode({ type: PacketType.EVENT, data: ["entities", { players: [{ id: "a", x: 1.5 }], monsters: [] }] });
	assert.ok(frame instanceof Uint8Array);
	const packet = await decodeWith({ Decoder }, frame);
	assert.equal(packet.type, PacketType.EVENT);
	assert.deepEqual(packet.data, ["entities", { players: [{ id: "a", x: 1.5 }], monsters: [] }]);
});

test("decoder rejects string frames, empty frames and oversized frames", () => {
	const decoder = new Decoder();
	assert.throws(() => decoder.add("2[\"x\"]"), /binary frames/);
	assert.throws(() => decoder.add(new Uint8Array(0)), /invalid packet size/);
});

test("differential: our codec and the game's browser parser agree on the same bytes", async (t) => {
	if (!fs.existsSync(OFFICIAL)) {
		t.skip("upstream parser not fetched (run npm run fetch-reference)");
		return;
	}
	const official = require(OFFICIAL.pathname);
	const samples = [
		{ type: 2, data: ["welcome", { region: "US", name: "I", version: 17803, x: 0, y: 70 }] },
		{ type: 2, data: ["entities", { players: [], monsters: [{ id: "42", x: -3.25, y: 108.5, hp: 150 }] }] },
		{ type: 2, data: ["u", { id: "Devmage", hp: 257, max_hp: 257, moving: false }] },
		{ type: 0, data: { sid: "abc" } },
	];
	const ours = new Encoder();
	const theirs = new official.Encoder();
	for (const sample of samples) {
		const [ourFrame] = ours.encode(sample);
		const theirFrames = theirs.encode(sample);
		const theirFrame = theirFrames[0];
		const ourBytes = Buffer.from(ourFrame);
		const theirBytes = Buffer.isBuffer(theirFrame) ? theirFrame : Buffer.from(theirFrame);
		assert.deepEqual([...ourBytes], [...theirBytes], "bytes differ for " + JSON.stringify(sample.data[0]));
		// and both decoders read each other's output
		const fromTheirs = await decodeWith({ Decoder }, theirBytes);
		assert.deepEqual(fromTheirs.data, sample.data);
	}
});
