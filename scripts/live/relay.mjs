// The local relay: merge what the party's clients see into one stream the watch page can render.
//
// The party plays on a real server; the page runs from the local game client on this machine. Rather
// than opening more sockets to the game (one observer per character), every client posts its world to
// this process over HTTP, and the browser reads a merged stream over Server-Sent Events. No external
// dependencies: node:http only.
//
//   POST /snapshot   one client's frame (JSON body, optional x-relay-token)
//   GET  /events     SSE, ?watch=<character> selects the camera, ?token=<relay token>
//   GET  /health     who is publishing and how stale
//   GET  /           a text status page that subscribes to /events (the fallback viewer)

import http from "node:http";
import { fileURLToPath } from "node:url";

export const RELAY_DEFAULTS = {
	host: "127.0.0.1",
	port: 7899,
	// A source that stopped publishing (a bot that crashed) must not keep its monsters on screen.
	staleMs: 10_000,
	// At most one frame per window, and only when something changed.
	rateMs: 100,
	maxEvents: 200,
	maxBodyBytes: 8 * 1024 * 1024,
};

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

function bagFill(self) {
	if (!self || !self.items || !self.items.length) return 0;
	const used = self.items.filter(Boolean).length;
	const size = self.isize || self.items.length || 0;
	return size ? Math.round((used / size) * 100) / 100 : 0;
}

/**
 * Merge every publisher's view into the one frame the page draws. Pure, so the merge is unit tested
 * without a server: pass a Map of name -> { snapshot, at }.
 *
 * The union is sound because every character is on the same map of the same server: world
 * coordinates are absolute, so four half-views of one fight compose into one picture. Each client
 * omits itself from its own player list, which is why every source's self entity is added back.
 *
 * The output order is stable (sources and roster sorted by name) even though the input is ordered by
 * arrival time; the "self" selection still prefers the freshest publisher when no name is watched.
 */
export function mergeSources(sources, { watch = null, staleMs = RELAY_DEFAULTS.staleMs, now = Date.now(), events = [] } = {}) {
	const entries = (sources instanceof Map ? [...sources.entries()] : Object.entries(sources || {}))
		.map(([name, entry]) => ({ name, snapshot: entry && entry.snapshot, at: (entry && entry.at) || 0 }))
		.filter((entry) => entry.snapshot && now - entry.at <= staleMs)
		.sort((a, b) => a.at - b.at || String(a.name).localeCompare(String(b.name)));
	const frame = {
		t: now,
		watch: watch || null,
		self: null,
		entities: { players: [], monsters: [], npcs: [] },
		drops: [],
		party: [],
		sources: [],
		events: events.slice(-RELAY_DEFAULTS.maxEvents),
	};
	if (!entries.length) return frame;
	const players = new Map();
	const monsters = new Map();
	const npcs = new Map();
	const drops = new Map();
	const roster = new Map();
	for (const entry of entries) {
		const snapshot = entry.snapshot;
		const self = snapshot.self;
		if (self && self.id !== undefined) {
			// A client never lists itself: put every publisher's own character back in the union.
			players.set(String(self.id), self);
		}
		for (const list of ["players", "monsters", "npcs"]) {
			const target = list === "players" ? players : list === "monsters" ? monsters : npcs;
			for (const entity of (snapshot.entities && snapshot.entities[list]) || []) {
				if (!entity || entity.id === undefined) continue;
				target.set(String(entity.id), entity);
			}
		}
		for (const drop of snapshot.drops || []) {
			if (!drop || drop.id === undefined) continue;
			drops.set(String(drop.id), drop);
		}
		for (const name of snapshot.party || []) {
			if (!name) continue;
			roster.set(String(name).toLowerCase(), String(name));
		}
		roster.set(String(entry.name).toLowerCase(), String(entry.name));
		if (self) {
			frame.sources.push({
				name: entry.name,
				role: snapshot.role || null,
				map: self.map || null,
				x: Math.round(self.x || 0),
				y: Math.round(self.y || 0),
				hp: self.hp,
				max_hp: self.max_hp,
				mp: self.mp,
				max_mp: self.max_mp,
				level: self.level || 0,
				ctype: self.ctype || null,
				gold: self.gold || 0,
				bagFill: bagFill(self),
				counters: snapshot.counters || null,
				ageMs: Math.max(0, now - entry.at),
			});
		}
	}
	const watched = watch ? entries.find((entry) => same(entry.name, watch)) : null;
	const chosen = watched || entries[entries.length - 1];
	frame.self = (chosen.snapshot && chosen.snapshot.self) || null;
	if (frame.self) frame.self = Object.assign({}, frame.self, { map: frame.self.map || null });
	frame.entities.players = [...players.values()];
	frame.entities.monsters = [...monsters.values()];
	frame.entities.npcs = [...npcs.values()];
	frame.drops = [...drops.values()];
	// Order must not depend on who published last: a viewer that re-sorts every frame cannot be read.
	frame.sources.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	frame.party = [...roster.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return frame;
}

function frameKey(frame) {
	// t changes every window; everything else is what the browser actually draws.
	const copy = Object.assign({}, frame);
	delete copy.t;
	return JSON.stringify(copy);
}

function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "access-control-allow-origin": "*", "cache-control": "no-store" });
	res.end(text);
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * Start the relay. Returns { server, port, url, close, sources, events } so a test can drive it
 * without spawning a process.
 */
export function startRelay({ host = RELAY_DEFAULTS.host, port = RELAY_DEFAULTS.port, staleMs = RELAY_DEFAULTS.staleMs, rateMs = RELAY_DEFAULTS.rateMs, token = null, log = () => {} } = {}) {
	const sources = new Map();
	const events = [];
	const viewers = new Set();
	let eventSeq = 0;
	let lastKey = null;
	const authOk = (value) => !token || String(value || "") === String(token);

	function frameNow(watch) {
		return mergeSources(sources, { watch, staleMs, now: Date.now(), events });
	}

	function broadcast() {
		if (!viewers.size) return;
		let key = null;
		for (const viewer of viewers) {
			const frame = frameNow(viewer.watch);
			const k = frameKey(frame);
			if (viewer.lastKey === k) continue;
			viewer.lastKey = k;
			key = k;
			viewer.res.write("event: frame\ndata: " + JSON.stringify(frame) + "\n\n");
		}
		lastKey = key || lastKey;
	}

	const server = http.createServer((req, res) => {
		const url = new URL(req.url || "/", "http://" + (req.headers.host || "relay"));
		if (req.method === "OPTIONS") {
			res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-relay-token", "access-control-allow-methods": "GET, POST, OPTIONS" });
			res.end();
			return;
		}
		if (url.pathname === "/health") {
			return sendJson(res, 200, {
				ok: true,
				viewers: viewers.size,
				sources: [...sources.entries()].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase())).map(([name, entry]) => {
					// A source stays in the map after it stops publishing (a bot that exited); the merge drops
					// it, so say so here instead of leaving a viewer wondering why it is not on screen.
					const ageMs = Date.now() - entry.at;
					return { name, role: (entry.snapshot && entry.snapshot.role) || null, ageMs, stale: ageMs > staleMs, map: (entry.snapshot && entry.snapshot.self && entry.snapshot.self.map) || null };
				}),
			});
		}
		if (url.pathname === "/snapshot" && req.method === "POST") {
			if (!authOk(req.headers["x-relay-token"])) return sendJson(res, 403, { ok: false, error: "token" });
			readBody(req, RELAY_DEFAULTS.maxBodyBytes).then((text) => {
				const snapshot = JSON.parse(text);
				const name = String((snapshot && snapshot.source) || "");
				if (!name) return sendJson(res, 400, { ok: false, error: "source" });
				sources.set(name, { snapshot, at: Date.now() });
				for (const event of snapshot.events || []) {
					events.push({ n: ++eventSeq, source: name, name: event.name, data: event.data });
				}
				if (events.length > RELAY_DEFAULTS.maxEvents) events.splice(0, events.length - RELAY_DEFAULTS.maxEvents);
				sendJson(res, 200, { ok: true, sources: sources.size });
			}).catch((error) => sendJson(res, 400, { ok: false, error: error.message }));
			return;
		}
		if (url.pathname === "/events") {
			if (!authOk(url.searchParams.get("token"))) return sendJson(res, 403, { ok: false, error: "token" });
			const viewer = { watch: url.searchParams.get("watch") || null, res, lastKey: null };
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
				"access-control-allow-origin": "*",
			});
			res.write("retry: 1000\n\n");
			viewers.add(viewer);
			broadcast();
			const heartbeat = setInterval(() => {
				try {
					res.write(": keep-alive\n\n");
				} catch {}
			}, 15_000);
			req.on("close", () => {
				clearInterval(heartbeat);
				viewers.delete(viewer);
			});
			return;
		}
		if (url.pathname === "/") {
			const text = statusPage(sources);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
			res.end(text);
			return;
		}
		sendJson(res, 404, { ok: false, error: "not found" });
	});

	const ticker = setInterval(broadcast, Math.max(50, Number(rateMs) || RELAY_DEFAULTS.rateMs));
	ticker.unref?.();
	const started = new Promise((resolve) => {
		server.listen(Number(port) || 0, host, () => {
			const address = server.address();
			const url = "http://" + host + ":" + address.port;
			log("relay listening on " + url);
			resolve(url);
		});
	});

	return {
		server,
		started,
		get port() {
			return server.address() ? server.address().port : port;
		},
		sources,
		events,
		close() {
			clearInterval(ticker);
			for (const viewer of viewers) {
				try {
					viewer.res.end();
				} catch {}
			}
			viewers.clear();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

function statusPage(sources) {
	const rows = [...sources.entries()].map(([name, entry]) => {
		const self = (entry.snapshot && entry.snapshot.self) || {};
		const age = Math.round((Date.now() - entry.at) / 1000);
		return "<tr><td>" + name + "</td><td>" + ((entry.snapshot && entry.snapshot.role) || "-") + "</td><td>" + (self.map || "-") + "</td><td>" + Math.round(self.x || 0) + "," + Math.round(self.y || 0) + "</td><td>" + Math.round(self.hp || 0) + "/" + Math.round(self.max_hp || 0) + "</td><td>" + age + "s</td></tr>";
	});
	return "<!doctype html><meta charset='utf-8'><title>party relay</title>" +
		"<style>body{font:13px system-ui,sans-serif;background:#14161a;color:#d8dee9;margin:24px}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #2b3038;text-align:left}th{color:#8fbcbb}</style>" +
		"<h1>party relay</h1><p>Watch a character: <code>/ ?watch=&lt;name&gt;</code> on the local client page, with <code>relay=1</code>.</p>" +
		"<table><tr><th>source</th><th>role</th><th>map</th><th>at</th><th>hp</th><th>age</th></tr>" + (rows.join("") || "<tr><td colspan=6>nothing publishing yet</td></tr>") + "</table>";
}

function parseArgs(argv) {
	const args = { host: RELAY_DEFAULTS.host, port: Number(process.env.AL_RELAY_PORT || RELAY_DEFAULTS.port), staleMs: RELAY_DEFAULTS.staleMs, rateMs: RELAY_DEFAULTS.rateMs, token: process.env.AL_RELAY_TOKEN || null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--host") args.host = argv[++i];
		else if (flag === "--port") args.port = Number(argv[++i]);
		else if (flag === "--stale-ms") args.staleMs = Number(argv[++i]);
		else if (flag === "--rate-ms") args.rateMs = Number(argv[++i]);
		else if (flag === "--token") args.token = argv[++i];
		else if (flag === "--help" || flag === "-h") args.help = true;
		else throw new Error("unknown flag: " + flag);
	}
	return args;
}

const USAGE = [
	"usage: node scripts/live/relay.mjs [--host 127.0.0.1] [--port 7899] [--stale-ms 10000] [--rate-ms 100] [--token <t>]",
	"",
	"  Clients post to POST /snapshot (env AL_PUBLISH=http://127.0.0.1:7899).",
	"  The watch page reads GET /events?watch=<character> (relay mode of the local client shim).",
].join("\n");

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const relay = startRelay({ ...args, log: (line) => console.log("[relay] " + line) });
	await relay.started;
	console.log("[relay] POST /snapshot from each client, GET /events?watch=<name> from the page");
	const stop = async (signal) => {
		console.log("[relay] " + signal + ", closing");
		await relay.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
}
