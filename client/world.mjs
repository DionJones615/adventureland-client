// The client's view of the world: who is on the map, where they are, and what changed.
//
// The interesting part is entity deltas. With entity_delta=1 in the handshake the server sends only
// changed fields, marked by a "~" array listing removed keys, against the last full packet the client
// holds (js/game.js decode_entities does the same reconstruction). A delta whose base is missing is
// dropped and the client asks for a complete view with send_updates.

import { EventEmitter } from "node:events";

const clone = (value) => JSON.parse(JSON.stringify(value));

export class World extends EventEmitter {
	constructor() {
		super();
		this.players = new Map();
		this.monsters = new Map();
		this.npcs = new Map();
		this.drops = new Map();
		this.bases = new Map(); // id -> last full packet, the base for the next delta
		this.self = null;
		this.map = null;
		this.in = null;
		this.x = 0;
		this.y = 0;
		this.missingDeltaBase = false;
	}

	reset() {
		this.players.clear();
		this.monsters.clear();
		this.npcs.clear();
		this.drops.clear();
		this.bases.clear();
		this.missingDeltaBase = false;
	}

	get(id) {
		return this.players.get(id) || this.monsters.get(id) || this.npcs.get(id) || null;
	}

	get entities() {
		return [...this.players.values(), ...this.monsters.values(), ...this.npcs.values()];
	}

	/**
	 * Which store an entity belongs to. Packets carry a "type" field only sometimes, so the list the
	 * server put the entity in is the reliable signal; NPCs are players with an "npc" field.
	 */
	_storeFor(entity, kind = null) {
		if (kind === "monster" || entity.type === "monster") return this.monsters;
		if (kind === "npc" || entity.npc || entity.type === "npc") return this.npcs;
		if (this.monsters.has(entity.id) && entity.type === undefined) return this.monsters;
		return this.players;
	}

	/** Rebuild a delta entry against its base packet, exactly like the official client. */
	_rebuild(entry) {
		if (!entry || !entry["~"]) return { entity: entry, complete: true };
		const base = this.bases.get(entry.id);
		if (!base) return { entity: null, complete: false };
		const full = clone(base);
		for (const [key, value] of Object.entries(entry)) if (key !== "~") full[key] = value;
		for (const key of entry["~"]) delete full[key];
		return { entity: full, complete: true };
	}

	/**
	 * Apply an "entities" payload. type "all" is a complete view of the map; anything else is
	 * incremental. Entries are full packets or "~" deltas.
	 */
	applyEntities(data, { reset = false } = {}) {
		if (!data || typeof data !== "object") return;
		if (data.in !== undefined && this.in !== null && data.in !== this.in) return; // stale map
		const isFull = reset || data.type === "all";
		if (isFull) {
			this.players.clear();
			this.monsters.clear();
			this.npcs.clear();
			this.bases.clear();
			this.missingDeltaBase = false;
		}
		let incomplete = false;
		for (const [list, kind] of [
			[data.players, "player"],
			[data.monsters, "monster"],
			[data.npcs, "npc"],
		]) {
			if (!Array.isArray(list)) continue;
			for (const entry of list) {
				const { entity, complete } = this._rebuild(entry);
				if (!complete) {
					incomplete = true;
					continue;
				}
				if (!entity || entity.id === undefined) continue;
				this.bases.set(entity.id, clone(entity));
				const store = this._storeFor(entity, kind);
				// An entity that changed kind must not linger in the old store.
				for (const other of [this.players, this.monsters, this.npcs]) if (other !== store) other.delete(entity.id);
				store.set(entity.id, entity);
			}
		}
		if (incomplete) {
			this.missingDeltaBase = true;
			this.emit("missing-delta-base");
		}
		this.emit("entities", data);
	}

	/** Merge one entity packet (event "u" or "player"). */
	upsert(entity) {
		if (!entity || entity.id === undefined) return null;
		const store = this._storeFor(entity);
		const existing = this.get(entity.id) || {};
		const merged = Object.assign({}, existing, entity);
		for (const key of Object.keys(entity)) if (entity[key] === undefined) delete merged[key];
		store.set(merged.id, merged);
		this.bases.set(merged.id, clone(merged));
		if (this.self && merged.id === this.self.id) this.self = merged;
		this.emit("entity", merged);
		return merged;
	}

	remove(id) {
		this.players.delete(id);
		this.monsters.delete(id);
		this.npcs.delete(id);
		this.drops.delete(id);
		this.bases.delete(id);
		this.emit("remove", id);
	}

	/** Dispatch a server event into the store. Returns true when the event was consumed. */
	handle(event, data) {
		switch (event) {
			case "welcome": {
				if (data.character) {
					this.self = data.character;
					this.players.set(data.character.id || data.character.name, this.self);
				}
				this.map = data.map;
				this.in = data.in;
				this.x = data.x;
				this.y = data.y;
				this.emit("welcome", data);
				return true;
			}
			case "players": {
				for (const player of Array.isArray(data) ? data : []) {
					if (!player || player.id === undefined) continue;
					this.players.set(player.id, player);
					this.bases.set(player.id, clone(player));
					if (this.self && player.id === this.self.id) this.self = player;
				}
				this.emit("players", data);
				return true;
			}
			case "entities": {
				this.applyEntities(data);
				return true;
			}
			case "new_map": {
				this.reset();
				this.map = data.name;
				this.in = data.in;
				this.x = data.x;
				this.y = data.y;
				if (data.entities) this.applyEntities(data.entities, { reset: true });
				this.emit("new_map", data);
				return true;
			}
			case "start": {
				// The login flow announces the character with "start", not "welcome"/"player".
				const entity = Object.assign({ type: "player" }, data);
				if (entity.id !== undefined) this.players.set(entity.id, entity);
				this.self = entity;
				if (entity.map) this.map = entity.map;
				if (entity.in) this.in = entity.in;
				this.x = entity.x ?? this.x;
				this.y = entity.y ?? this.y;
				if (data.entities) this.applyEntities(data.entities, { reset: true });
				this.emit("start", data);
				this.emit("self", entity);
				return true;
			}
			case "player": {
				const entity = this.upsert(Object.assign({ type: "player" }, data));
				// The first "player" packet after auth is this character; later ones are updates.
				if (entity && (!this.self || entity.id === this.self.id || (entity.real_id && entity.real_id === this.self.real_id))) {
					this.self = entity;
					this.x = entity.x;
					this.y = entity.y;
					this.map = entity.map || this.map;
					this.in = entity.in || this.in;
					this.emit("self", entity);
				}
				return true;
			}
			case "u": {
				const entity = this.upsert(data);
				if (entity && this.self && entity.id === this.self.id) {
					this.x = entity.x;
					this.y = entity.y;
					this.emit("self", entity);
				}
				return true;
			}
			case "disappear":
			case "death": {
				if (data && data.id !== undefined) this.remove(data.id);
				this.emit(event, data);
				return true;
			}
			case "drop": {
				if (data && data.id !== undefined) {
					this.drops.set(data.id, data);
					this.emit("drop", data);
				}
				return true;
			}
			default:
				return false;
		}
	}
}
