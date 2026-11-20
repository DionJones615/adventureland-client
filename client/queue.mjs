// Request queue: what turns fire-and-forget socket emits into promises.
//
// Two jobs. First, rate limiting: the game server counts call cost per character and disconnects
// abusers (socket.on -> add_call_cost -> "limitdc"), so every event has a minimum interval here.
// Second, correlation: a response is matched to the request that caused it. The game answers most
// actions with game_response {response, place}, where "place" is the emitting event name.

import { DisconnectedError, TimeoutError } from "./errors.mjs";

export const DEFAULT_INTERVALS = Object.freeze({
	move: 100,
	attack: 60,
	skill: 120,
	use: 120,
	equip: 120,
	equip_batch: 120,
	say: 250,
	send: 250,
	party: 200,
	open_chest: 150,
	send_updates: 250,
	respawn: 500,
	default: 100,
});

export class RequestQueue {
	constructor({ send, intervals = {}, defaultTimeoutMs = 10_000, now = Date.now } = {}) {
		if (typeof send !== "function") throw new Error("RequestQueue needs a send(event, data) function");
		this.send = send;
		this.intervals = Object.assign({}, DEFAULT_INTERVALS, intervals);
		this.defaultTimeoutMs = defaultTimeoutMs;
		this.now = now;
		this.pending = new Map();
		this.lastSent = new Map();
		this.seq = 0;
	}

	interval(event) {
		return this.intervals[event] ?? this.intervals.default;
	}

	/**
	 * Emit an event and resolve with the server's answer.
	 * @param {string} event
	 * @param {object} data
	 * @param {object} [options]
	 * @param {string[]} [options.resolveOn] server events that can settle it (default game_response)
	 * @param {(payload: any) => boolean} [options.match] extra filter on the payload
	 */
	push(event, data, { resolveOn = ["game_response"], match = null, timeoutMs = this.defaultTimeoutMs } = {}) {
		const id = ++this.seq;
		const promise = new Promise((resolve, reject) => {
			const entry = { id, event, data, resolveOn, match, resolve, reject, timer: null };
			entry.timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new TimeoutError(event, timeoutMs));
			}, timeoutMs);
			this.pending.set(id, entry);
			this._sendWhenAllowed(entry);
		});
		return promise;
	}

	async _sendWhenAllowed(entry) {
		const interval = this.interval(entry.event);
		const last = this.lastSent.get(entry.event) ?? 0;
		const wait = last + interval - this.now();
		// Deliberately NOT unref: a request in flight means the process still has work to do, and an
		// unref timer lets the event loop drain before the answer arrives (a flaky test on Node 22).
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		if (!this.pending.has(entry.id)) return; // already timed out
		this.lastSent.set(entry.event, this.now());
		try {
			this.send(entry.event, entry.data);
		} catch (error) {
			this.pending.delete(entry.id);
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	/** Route a server event into pending requests. */
	settle(event, payload) {
		if (!this.pending.size) return 0;
		let settled = 0;
		for (const entry of Array.from(this.pending.values())) {
			const targeted = entry.match
				? entry.match(payload, event)
				: event === "game_response"
					? payload && payload.place === entry.event
					: entry.resolveOn.includes(event);
			if (!targeted) continue;
			this.pending.delete(entry.id);
			clearTimeout(entry.timer);
			entry.resolve(payload);
			settled++;
		}
		return settled;
	}

	/** Reject everything in flight, e.g. on disconnect. */
	fail(reason = "disconnected") {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new DisconnectedError(reason));
		}
		this.pending.clear();
	}

	get size() {
		return this.pending.size;
	}
}
