// A thin socket.io-client wrapper: one transport, explicit lifecycle, no hidden reconnection.
//
// Adventure Land uses Socket.IO v4 with websocket-only transport. The JSON endpoint takes the stock
// parser; the MessagePack endpoint requires a matching parser from the very first packet - mixing
// them breaks the connection, which is why the choice is made here and never switched mid-session.

import { io } from "socket.io-client";
import {
	ClientError,
	DisconnectedError,
	TimeoutError,
} from "../errors.mjs";
import { parser as msgpackParser } from "./msgpack-parser.mjs";

export const DEFAULT_QUERY = Object.freeze({
	map_protocol: "1",
	entity_delta: "1",
	no_graphics: "1",
});

export class GameSocket {
	/**
	 * @param {object} options
	 * @param {string} options.address  e.g. http://127.0.0.1:7192
	 * @param {string} [options.path]   /socket.io/ (JSON) - ignored when msgpack is set
	 * @param {string} [options.msgpackPath] /socket.io-msgpack/
	 * @param {boolean|string} [options.transport] "json" | "msgpack"
	 */
	constructor({ address, path = "/socket.io/", msgpackPath = "/socket.io-msgpack/", transport = "json", query = {}, timeoutMs = 20_000 } = {}) {
		if (!address) throw new ClientError("a server address is required");
		this.address = address;
		this.transport = transport === "msgpack" ? "msgpack" : "json";
		this.path = this.transport === "msgpack" ? msgpackPath : path;
		this.query = Object.assign({}, DEFAULT_QUERY, query);
		this.timeoutMs = timeoutMs;
		this.listeners = new Map();
		this.socket = null;
	}

	get connected() {
		return Boolean(this.socket && this.socket.connected);
	}

	on(event, listener) {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event).add(listener);
		return () => this.listeners.get(event)?.delete(listener);
	}

	_emitLocal(event, ...args) {
		for (const listener of this.listeners.get(event) || []) {
			try {
				listener(...args);
			} catch (error) {
				this.onError?.(error);
			}
		}
	}

	async connect() {
		if (this.socket) throw new ClientError("socket already created");
		const options = {
			path: this.path,
			transports: ["websocket"],
			query: this.query,
			forceNew: true,
			reconnection: false,
			timeout: this.timeoutMs,
			upgrade: false,
		};
		if (this.transport === "msgpack") options.parser = msgpackParser;

		this.socket = io(this.address, options);
		this.socket.onAny((event, ...args) => {
			this._emitLocal("event", event, args);
			this._emitLocal(event, ...args);
			this.onEvent?.(event, args[0]);
		});
		this.socket.on("disconnect", (reason) => this._emitLocal("disconnect", reason));

		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new TimeoutError("socket connect", this.timeoutMs));
			}, this.timeoutMs);
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (error) => {
				cleanup();
				reject(new ClientError("socket connect failed: " + (error?.message || error), { cause: error }));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.socket.off("connect", onConnect);
				this.socket.off("connect_error", onError);
			};
			this.socket.once("connect", onConnect);
			this.socket.once("connect_error", onError);
		});
		return this;
	}

	onGameEvent(event, listener) {
		if (!this.socket) throw new ClientError("socket not connected");
		this.socket.on(event, listener);
		return () => this.socket.off(event, listener);
	}

	emit(event, data = {}) {
		if (!this.connected) throw new DisconnectedError("cannot emit " + event);
		this.socket.emit(event, data);
	}

	/**
	 * Wait for one event, or fail after timeoutMs. Subscribes through the local emitter rather than
	 * the raw socket, so it can be called *before* connect(): the server's "welcome" arrives on the
	 * same tick as the handshake completes, and a listener attached afterwards would miss it.
	 */
	once(event, { timeoutMs = this.timeoutMs, filter } = {}) {
		return new Promise((resolve, reject) => {
			let off = null;
			const timer = setTimeout(() => {
				off?.();
				reject(new TimeoutError(event, timeoutMs));
			}, timeoutMs);
			off = this.on(event, (value) => {
				if (filter && !filter(value)) return;
				clearTimeout(timer);
				off();
				resolve(value);
			});
		});
	}

	close() {
		if (!this.socket) return;
		const socket = this.socket;
		this.socket = null;
		socket.removeAllListeners();
		socket.disconnect();
	}
}
