#!/usr/bin/env node
// Watch a character that is already playing: attach as an observer, exactly the way the browser does.
//
// js/game.js observe_character(name) takes the character's secret from servers_and_characters (present
// only while the character is online), reconnects with "?secret=<secret>&desktop=1", and the server
// answers welcome.character - the full entity (node/server.js, handshake.query.secret). The observer
// then emits "loaded" to register, after which entity updates for the character and its surroundings
// stream in. That is the same channel the browser's watch view uses, so this script is a text renderer
// for it.
//
// Usage:
//   node scripts/watch.mjs Devmage --seconds 20 --width 31 --height 11

import { ALClient } from "../client/index.mjs";

function parseArgs(argv) {
	const options = {
		name: null,
		seconds: 20,
		apiBaseUrl: process.env.AL_API_URL || "http://127.0.0.1:8090",
		email: process.env.AL_EMAIL || "dev@example.test",
		password: process.env.AL_PASSWORD || "dev-password-123",
		transport: process.env.AL_TRANSPORT || "json",
		width: 31,
		height: 11,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--seconds") options.seconds = Number(argv[++i]);
		else if (arg === "--api") options.apiBaseUrl = argv[++i];
		else if (arg === "--email") options.email = argv[++i];
		else if (arg === "--password") options.password = argv[++i];
		else if (arg === "--msgpack") options.transport = "msgpack";
		else if (arg === "--width") options.width = Number(argv[++i]);
		else if (arg === "--height") options.height = Number(argv[++i]);
		else if (arg === "--quiet") options.quiet = true;
		else if (!arg.startsWith("--")) options.name = arg;
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.name) {
	console.error("usage: node scripts/watch.mjs <character> [--seconds N] [--msgpack] [--quiet]");
	process.exit(1);
}

const client = new ALClient({ apiBaseUrl: options.apiBaseUrl });
await client.login({ email: options.email, password: options.password, onlyLogin: true });

const characters = await client.characters();
const character = characters.find((entry) => String(entry.name).toLowerCase() === options.name.toLowerCase());
if (!character) {
	console.error("no character named " + options.name + " on this account");
	process.exit(1);
}
if (!character.secret) {
	console.error(character.name + " is offline - its secret only exists while it is online.");
	console.error("start the player first, e.g. node scripts/watch.mjs --help for the pair");
	process.exit(1);
}
const servers = await client.servers();
const server = servers.find((entry) => entry.key === character.server) || servers[0];

const transport = {};
if (options.transport === "msgpack") transport.query = {};
await client.connect({ server, transport: options.transport, query: { secret: character.secret, desktop: "1" } });

const welcome = client.welcome;
if (!welcome || !welcome.character) {
	console.error("the server did not attach the character: the secret is stale (it is regenerated on every login)");
	process.exit(1);
}
const id = welcome.character.id;
// Register as an observer so the server starts streaming the neighbourhood (node/server.js loaded).
client.socket.emit("loaded", { width: 1000, height: 700, scale: 2 });

// An observer has a fixed position: the server only streams entities within its vision, and the
// browser client's camera follows "character" - which an observer never has - so both drift away
// from the watched player. "o:home" is the supported recenter: the server transports the observer to
// the player's current tile (node/server.js socket.on("o:home") -> transport_observer_to). The
// browser does the same thing when you click the character a second time.
let follow = null;
if (!process.argv.includes("--no-follow")) {
	follow = setInterval(() => {
		try {
			client.socket.emit("o:home", {});
		} catch {}
	}, 8000);
	follow.unref?.();
}

// Entity packets carry a destination (going_x/going_y) and a speed, not a stream of positions - the
// browser client extrapolates between packets (entity_animations.js move_character). A watcher that
// renders raw packet coordinates looks frozen, so track a local copy and advance it the same way.
const motion = new Map();
function track(entity) {
	if (!entity || entity.id === undefined) return;
	motion.set(entity.id, {
		x: entity.x,
		y: entity.y,
		going_x: entity.going_x ?? entity.x,
		going_y: entity.going_y ?? entity.y,
		speed: entity.speed || 100,
		moving: Boolean(entity.moving),
		stamp: Date.now(),
	});
}
function at(entity, now) {
	const local = motion.get(entity.id);
	if (!local) return { x: entity.x, y: entity.y, moving: Boolean(entity.moving) };
	if (!local.moving) return local;
	const dt = Math.min(1, (now - local.stamp) / 1000);
	local.stamp = now;
	const dx = local.going_x - local.x;
	const dy = local.going_y - local.y;
	const distance = Math.hypot(dx, dy);
	if (distance < 1) {
		local.moving = false;
		return local;
	}
	const step = Math.min(distance, local.speed * dt);
	local.x += (dx / distance) * step;
	local.y += (dy / distance) * step;
	if (step >= distance) local.moving = false;
	return local;
}
client.world.on("entity", track);
client.world.on("self", track);
client.world.on("players", (players) => (players || []).forEach(track));
client.world.on("entities", (data) => {
	for (const list of [data.players, data.monsters, data.npcs]) for (const entity of list || []) track(entity);
});
track(welcome.character);

const seen = [];
client.on("hit", (hit) => seen.push("hit " + hit.id + " -> " + Math.round(hit.damage) + " dmg"));
client.on("game_response", (response) => {
	if (response && response.response && response.place) seen.push(response.place + ": " + response.response);
});
client.on("disappear", (data) => seen.push("disappear " + data.id));
client.on("disconnect_reason", (reason) => seen.push("disconnected: " + reason));

const CELL = 10;
const halfW = Math.floor(options.width / 2);
const halfH = Math.floor(options.height / 2);

function render(now) {
	const selfEntity = client.world.self || client.world.get(id) || welcome.character;
	const self = Object.assign({}, selfEntity, at(selfEntity, now));
	const cx = Math.round(self.x / CELL);
	const cy = Math.round(self.y / CELL);
	const grid = [];
	for (let row = -halfH; row <= halfH; row++) grid.push(new Array(options.width).fill("."));
	const put = (entity, glyph) => {
		const point = at(entity, now);
		const gx = Math.round(point.x / CELL) - cx + halfW;
		const gy = Math.round(point.y / CELL) - cy + halfH;
		if (gx < 0 || gy < 0 || gx >= options.width || gy >= options.height) return;
		if (grid[gy][gx] === ".") grid[gy][gx] = glyph;
	};
	for (const monster of client.world.monsters.values()) put(monster, "m");
	for (const npc of client.world.npcs.values()) put(npc, "n");
	for (const player of client.world.players.values()) if (player.id !== id) put(player, "p");
	grid[halfH][halfW] = "@";
	const hp = Math.round(self.hp) + "/" + Math.round(self.max_hp || 0);
	const mp = Math.round(self.mp) + "/" + Math.round(self.max_mp || 0);
	const where = (self.map || "?") + " (" + Math.round(self.x) + ", " + Math.round(self.y) + ")";
	const state = self.moving ? "moving" : "standing";
	const header = "t+" + ((now - started) / 1000).toFixed(1) + "s  " + where + "  hp " + hp + "  mp " + mp + "  " + state;
	const lines = [header];
	for (const row of grid) lines.push("  " + row.join(""));
	if (seen.length) {
		lines.push("  " + seen.splice(0, 4).join(" | "));
	}
	console.log(lines.join("\n") + "\n");
}

const started = Date.now();
console.log("watching " + character.name + " on " + server.region + " " + server.name + " (" + server.address + server.path + ")\n");
render(Date.now());
const timer = setInterval(() => render(Date.now()), 1000);
setTimeout(() => {
	clearInterval(timer);
	if (follow) clearInterval(follow);
	client.disconnect();
	process.exit(0);
}, Math.max(1000, options.seconds * 1000));
