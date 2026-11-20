// Socket.IO v5 packet codec for the MessagePack transport.
//
// This mirrors node/msgpack_parser.js from the game server: packets travel as positional arrays
// [type], [type, data] or [type, id, data], MessagePack-encoded, with no binary payloads. It is
// deliberately not the browser bundle the game ships (js/socket.io-msgpack-parser.min.js); the test
// suite diffs the two so a divergence shows up as a failure instead of a mystery.

import { Decoder as MessagePackDecoder, Encoder as MessagePackEncoder } from "@msgpack/msgpack";

export const protocol = 5;

export const PacketType = Object.freeze({
	CONNECT: 0,
	DISCONNECT: 1,
	EVENT: 2,
	ACK: 3,
	CONNECT_ERROR: 4,
});

const MAX_PACKET_BYTES = 4 * 1024 * 1024;

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventData(value) {
	return Array.isArray(value) && value.length > 0 && typeof value[0] === "string";
}

function validId(id) {
	return Number.isInteger(id) && id >= 0;
}

export function packetToTuple(packet) {
	switch (packet.type) {
		case PacketType.CONNECT:
			return packet.data === undefined ? [PacketType.CONNECT] : [PacketType.CONNECT, packet.data];
		case PacketType.DISCONNECT:
			return [PacketType.DISCONNECT];
		case PacketType.EVENT:
			if (packet.id === undefined) return [PacketType.EVENT, packet.data];
			if (!validId(packet.id)) throw new Error("invalid packet id");
			return [PacketType.EVENT, packet.id, packet.data];
		case PacketType.ACK:
			if (!validId(packet.id) || !Array.isArray(packet.data)) throw new Error("invalid ACK packet");
			return [PacketType.ACK, packet.id, packet.data];
		case PacketType.CONNECT_ERROR:
			return [PacketType.CONNECT_ERROR, packet.data];
		default:
			throw new Error("unsupported packet type: " + packet.type);
	}
}

export function tupleToPacket(tuple) {
	if (!Array.isArray(tuple) || tuple.length === 0) throw new Error("invalid packet frame");
	const type = tuple[0];
	if (!Number.isInteger(type)) throw new Error("invalid packet type");
	switch (type) {
		case PacketType.CONNECT:
			return tuple.length === 1 ? { type, nsp: "/" } : { type, nsp: "/", data: tuple[1] };
		case PacketType.DISCONNECT:
			return { type, nsp: "/" };
		case PacketType.EVENT:
			if (tuple.length === 2 && eventData(tuple[1])) return { type, nsp: "/", data: tuple[1] };
			if (tuple.length === 3 && validId(tuple[1]) && eventData(tuple[2]))
				return { type, nsp: "/", id: tuple[1], data: tuple[2] };
			throw new Error("invalid EVENT packet");
		case PacketType.ACK:
			if (tuple.length !== 3 || !validId(tuple[1]) || !Array.isArray(tuple[2])) throw new Error("invalid ACK packet");
			return { type, nsp: "/", id: tuple[1], data: tuple[2] };
		case PacketType.CONNECT_ERROR:
			if (tuple.length !== 2) throw new Error("invalid CONNECT_ERROR packet");
			return { type, nsp: "/", data: tuple[1] };
		default:
			throw new Error("unsupported packet type: " + type);
	}
}

export class Encoder {
	constructor() {
		this.encoder = new MessagePackEncoder();
	}
	encode(packet) {
		return [this.encoder.encode(packetToTuple(packet))];
	}
}

export class Decoder {
	constructor() {
		this.decoder = new MessagePackDecoder();
		this.listeners = { decoded: [] };
	}
	on(event, listener) {
		(this.listeners[event] ||= []).push(listener);
		return this;
	}
	off(event, listener) {
		const list = this.listeners[event];
		if (!list) return this;
		if (!listener) delete this.listeners[event];
		else this.listeners[event] = list.filter((entry) => entry !== listener);
		return this;
	}
	add(frame) {
		const bytes =
			frame instanceof Uint8Array
				? frame
				: typeof frame === "string"
					? null
					: frame instanceof ArrayBuffer
						? new Uint8Array(frame)
						: ArrayBuffer.isView(frame)
							? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
							: null;
		if (!bytes) throw new Error("MessagePack packets must arrive as binary frames");
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_PACKET_BYTES) throw new Error("invalid packet size");
		const packet = tupleToPacket(this.decoder.decode(bytes));
		for (const listener of this.listeners.decoded || []) listener.call(this, packet);
		return this;
	}
	destroy() {
		this.listeners = {};
	}
}

/** The shape socket.io-client expects from a custom parser. */
export const parser = { protocol, PacketType, Encoder, Decoder };
export default parser;
