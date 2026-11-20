// Publish this client's world view to the local relay so the watch page can render it.
//
// The party plays on one server; a viewer runs on this machine. Instead of opening extra sockets to
// the game (an observer per character, each one more session to get rate limited), every running
// client posts what it already knows - its own entity, the entities around it, its bag and gold - to
// scripts/live/relay.mjs, which merges the four views and serves them to the browser page.
//
// Nothing here is allowed to disturb a loop: a missing relay means every POST is a rejected promise
// that is swallowed.

/** Which server events are worth injecting into the watch page (a hit, a skill, a chat line, a drop). */
const INTERESTING = new Set(["hit", "action", "chat_log", "skill_timeout", "drop", "disappear", "game_response", "player", "u"]);

const MAX_EVENTS = 120;
const MAX_PLAYERS = 60;
const MAX_MONSTERS = 140;
const MAX_NPCS = 60;

function plain(value) {
	if (!value || typeof value !== "object") return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "function") continue;
		out[key] = item;
	}
	return out;
}

function items(self) {
	return ((self && self.items) || []).map((item) => (item && typeof item === "object" ? plain(item) : item));
}

function slots(self) {
	const out = {};
	for (const [key, item] of Object.entries((self && self.slots) || {})) out[key] = item && typeof item === "object" ? plain(item) : item;
	return out;
}

function listed(map, limit) {
	const out = [];
	for (const entity of (map || new Map()).values()) {
		if (!entity || entity.id === undefined) continue;
		out.push(plain(entity));
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * One frame of this client's world. Pure: give it a client-shaped object and it answers the frame the
 * relay merges, which is what the unit test does.
 */
export function buildSnapshot(client, { role = null, counters = null, events = [], now = Date.now() } = {}) {
	const world = (client && client.world) || {};
	const self = world.self || null;
	const selfId = self && self.id !== undefined ? String(self.id) : null;
	const snapshot = {
		source: (self && self.id) || (client && client.character) || "unknown",
		role,
		t: now,
		self: self
			? Object.assign(plain(self), {
					id: selfId,
					items: items(self),
					slots: slots(self),
					gold: self.gold || 0,
					isize: self.isize || 0,
					level: self.level || 0,
					ctype: self.ctype || null,
					map: self.map || world.map || null,
					in: self.in || self.map || world.map || null,
			  })
			: null,
		party: (world.party && Array.isArray(world.party.list) ? world.party.list.slice() : []),
		entities: {
			players: listed(world.players, MAX_PLAYERS).filter((entity) => String(entity.id) !== selfId),
			monsters: listed(world.monsters, MAX_MONSTERS),
			npcs: listed(world.npcs, MAX_NPCS),
		},
		drops: listed(world.drops, 80).map((drop) => ({ id: drop.id, x: drop.x, y: drop.y, items: drop.items ? drop.items.length : undefined })),
		counters: counters ? Object.assign({}, counters) : null,
		events: events.slice(0, MAX_EVENTS),
	};
	return snapshot;
}

/**
 * Start posting buildSnapshot() every intervalMs. Returns a handle with stop(); the timer is unref'd
 * so a bot that is done can still exit while a publisher was forgotten.
 */
export function createPublisher(client, { url, role = null, getCounters = () => null, intervalMs = 200, token = null, fetchImpl = globalThis.fetch, onError = null, now = Date.now } = {}) {
	if (!url) return null;
	const endpoint = String(url).replace(/\/+$/, "") + "/snapshot";
	const headers = { "content-type": "application/json", "user-agent": "adventureland-client/1.0" };
	if (token) headers["x-relay-token"] = String(token);
	const buffer = [];
	let timer = null;
	let inflight = false;
	let stopped = false;
	const stats = { sent: 0, failed: 0, lastError: null };
	const source = (client && client.world && client.world.self && client.world.self.id) || (client && client.character) || "unknown";

	client.on("event", (name, data) => {
		if (!INTERESTING.has(name)) return;
		if (buffer.length >= MAX_EVENTS) buffer.shift();
		buffer.push({ name, data: plain(data) });
	});

	const snapshotNow = () => buildSnapshot(client, { role, counters: getCounters(), events: buffer.splice(0, buffer.length), now: now() });

	const flush = () => {
		if (stopped || inflight) return;
		const frame = snapshotNow();
		if (!frame || !frame.self) return;
		if (typeof fetchImpl !== "function") return;
		inflight = true;
		Promise.resolve()
			.then(() =>
				fetchImpl(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(frame),
					signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
				}),
			)
			.then((response) => {
				stats.sent++;
				if (response && response.ok === false) stats.lastError = "http " + response.status;
			})
			.catch((error) => {
				stats.failed++;
				stats.lastError = error && error.message ? error.message : String(error);
				if (typeof onError === "function") onError(stats.lastError);
			})
			.finally(() => {
				inflight = false;
			});
	};

	return {
		source,
		endpoint,
		stats,
		flush,
		start() {
			if (timer || stopped) return this;
			timer = setInterval(flush, Math.max(50, Number(intervalMs) || 200));
			timer.unref?.();
			return this;
		},
		stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = null;
		},
	};
}
