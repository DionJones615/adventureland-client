// Party helpers: who is in the party, what the whole group should hit, and how loot reaches the
// merchant.
//
// Everything the game offers here is thin but real (node/server.js):
//   socket.on("party")       invite / request / accept / raccept / leave / kick, answered with a flat
//                            game_response plus a party_update carrying { list, party }
//   socket.on("say")         { party: true } reaches every member as partym
//   socket.on("send")        one character hands an item to another on the same map (B.dist = 400)
//   socket.on("open_chest")  loot piles are opened explicitly; walking over one collects nothing
//
// The one non-obvious rule: a party chest splits items by each member's damage share, and a merchant
// always has share 0 - so a merchant can never loot a chest. Loot therefore travels from the
// fighters to the merchant with "send". See loops/party/README.md.

import { inventoryFill, sellableItems } from "./loop.mjs";

export const PARTY_DEFAULTS = {
	/** How often a join attempt is retried, and how long one ensureParty call keeps trying. */
	joinRetryMs: 3000,
	joinTimeoutMs: 60_000,
	/** Bag fraction at which a fighter hands loot to the merchant. */
	sendAt: 0.4,
	/** Bag fraction at which the merchant sells. */
	sellAtFill: 0.5,
	/** Heal a party member below this fraction of max hp. */
	healBelow: 0.55,
	/** Chests worth walking to. */
	chestRange: 320,
	/** How far from the anchor a focus target may be. */
	focusChase: 420,
	/** Merchant buff range (G.skills.mluck.range = 320). */
	buffRange: 320,
};

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** "x,y" or { x, y } -> { x, y } | null. A malformed anchor is a configuration bug, so it throws. */
export function parseAnchor(value) {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value === "object" && Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: Number(value.x), y: Number(value.y) };
	const text = String(value).trim();
	const match = /^(-?[0-9]+(?:\.[0-9]+)?)\s*,\s*(-?[0-9]+(?:\.[0-9]+)?)$/.exec(text);
	if (!match) throw new Error("expected an anchor as 'x,y', got " + JSON.stringify(text));
	return { x: Number(match[1]), y: Number(match[2]) };
}

/** The roster the server last sent (world.party.list), or an empty array. */
export function partyRoster(client) {
	const party = client && client.world && client.world.party;
	return party && Array.isArray(party.list) ? party.list.slice() : [];
}

/** The character this client drives, as the server spells it. */
export function selfName(client) {
	const self = client && client.world && client.world.self;
	return (self && (self.id || self.name)) || client.character || null;
}

/** True when every wanted name appears in the roster. */
export function partyComplete(client, wanted) {
	const roster = partyRoster(client);
	if (!roster.length || !wanted || !wanted.length) return false;
	return wanted.every((name) => roster.some((entry) => same(entry, name)));
}

/**
 * The target every member of the party should hit.
 *
 * Deterministic on purpose: all members run the same function over (mostly) the same entities and
 * the same configured anchor, so they converge on one monster instead of spreading damage. Order:
 * distance to the anchor in 25-unit buckets (positions are shared and stable, hp is not), then lowest
 * hp, then id. Rounding the distance is what keeps the group from chasing jitter.
 */
export function focusTarget({ monsters = [], anchor, self, avoid, maxDistance = PARTY_DEFAULTS.focusChase, maxHpFraction = 1 } = {}) {
	if (!anchor) return null;
	const blocked = avoid instanceof Set ? avoid : new Set(avoid || []);
	const candidates = [];
	for (const monster of monsters || []) {
		if (!monster || monster.id === undefined) continue;
		if (monster.dead || monster.rip) continue;
		if (typeof monster.x !== "number" || typeof monster.y !== "number") continue;
		if (blocked.has(String(monster.id))) continue;
		if (self && same(monster.id, self.id)) continue;
		const fromAnchor = Math.hypot(monster.x - anchor.x, monster.y - anchor.y);
		if (fromAnchor > maxDistance) continue;
		if (maxHpFraction < 1 && Number.isFinite(monster.hp) && Number.isFinite(monster.max_hp) && monster.max_hp > 0) {
			if (monster.hp / monster.max_hp > maxHpFraction) continue;
		}
		const hp = Number.isFinite(monster.hp) ? monster.hp : Number.MAX_SAFE_INTEGER;
		const bucket = Math.round(fromAnchor / 25);
		candidates.push({ monster, hp, bucket, fromAnchor });
	}
	candidates.sort((a, b) => a.bucket - b.bucket || a.hp - b.hp || a.fromAnchor - b.fromAnchor || String(a.monster.id).localeCompare(String(b.monster.id)));
	return candidates.length ? candidates[0].monster : null;
}

/** The party member (in view) with the lowest hp fraction, optionally only below a threshold. */
export function lowestHpMember({ client, members = [], maxDistance = PARTY_DEFAULTS.focusChase, self = null } = {}) {
	const players = (client && client.world && client.world.players) || new Map();
	const me = self || (client && client.world && client.world.self);
	let best = null;
	for (const name of members || []) {
		if (me && same(name, me.id)) continue;
		const entity = players.get(name) || [...players.values()].find((player) => player && same(player.id, name));
		if (!entity || entity.rip || entity.dead) continue;
		if (!Number.isFinite(entity.hp) || !Number.isFinite(entity.max_hp) || entity.max_hp <= 0) continue;
		if (me && typeof me.x === "number" && typeof entity.x === "number" && Math.hypot(entity.x - me.x, entity.y - me.y) > maxDistance) continue;
		const ratio = entity.hp / entity.max_hp;
		const distance = me && typeof me.x === "number" ? Math.hypot(entity.x - me.x, entity.y - me.y) : 0;
		if (!best || ratio < best.ratio || (ratio === best.ratio && distance < best.distance)) best = { name: entity.id, entity, ratio, distance };
	}
	return best;
}

/** Loot piles within reach, nearest first. */
export function chestsNearby({ drops = [], self, range = PARTY_DEFAULTS.chestRange } = {}) {
	if (!self || typeof self.x !== "number") return [];
	return (drops || [])
		.filter((drop) => drop && drop.id !== undefined && typeof drop.x === "number" && typeof drop.y === "number")
		.map((drop) => ({ id: drop.id, x: drop.x, y: drop.y, distance: Math.hypot(drop.x - self.x, drop.y - self.y) }))
		.filter((drop) => drop.distance <= range)
		.sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id)));
}

/** Items a fighter should hand to the merchant: everything sellable, potions included. */
export function sendPlan(self, { potionStock = 0 } = {}) {
	if (!self) return [];
	return sellableItems(self, { potionStock });
}

/** True when the bag is full enough that the merchant trip is worth it. */
export function shouldSend(self, { sendAt = PARTY_DEFAULTS.sendAt } = {}) {
	return inventoryFill(self) >= sendAt && sendPlan(self).length > 0;
}

const watchers = new WeakMap();

/**
 * Answer party handshakes for the rest of the session: a leader raccepts join requests, a member
 * accepts the leader's invites. Installed once per client (idempotent), because a leader that stops
 * listening stops growing its party.
 */
export function watchPartyInvites({ client, leader, log = () => {} } = {}) {
	const owner = leader ? String(leader) : null;
	const existing = watchers.get(client);
	if (existing && existing.leader === owner) return existing.stop;
	if (existing) existing.stop();

	const self = selfName(client);
	const isLeader = self && owner && same(self, owner);
	const handle = (event, data) => {
		const from = data && (data.name || data.id);
		if (!from || same(from, self)) return;
		if (partyRoster(client).some((name) => same(name, from))) return;
		const answer = event === "request" && isLeader ? "raccept" : event === "invite" && !isLeader && owner && same(from, owner) ? "accept" : null;
		if (!answer) return;
		Promise.resolve(client.party({ event: answer, name: from })).catch((error) => log("party " + answer + " for " + from + " failed: " + error.message));
	};
	const onInvite = (data) => handle("invite", data);
	const onRequest = (data) => handle("request", data);
	if (typeof client.on === "function") {
		client.on("invite", onInvite);
		client.on("request", onRequest);
	}
	const stop = () => {
		if (typeof client.off === "function") {
			client.off("invite", onInvite);
			client.off("request", onRequest);
		}
		watchers.delete(client);
	};
	watchers.set(client, { leader: owner, stop });
	return stop;
}

/**
 * Bring the character into the party (and keep it there).
 *
 * A leader invites every wanted member that is missing and answers join requests; a member asks the
 * leader and accepts its invites. Loops call this once at start (it retries for up to timeoutMs) and
 * then maintainParty every few seconds. The handshake watcher stays installed, so a late member can
 * still join after this returned.
 */
export async function ensureParty({ client, log = () => {}, leader, members = [], role = null, shouldStop = () => false, sleep, timeoutMs = PARTY_DEFAULTS.joinTimeoutMs, retryMs = PARTY_DEFAULTS.joinRetryMs } = {}) {
	const self = selfName(client);
	if (!self) return false;
	const owner = leader || (members || [])[0] || self;
	const wanted = Array.from(new Set([owner, ...(members || [])].filter(Boolean).map(String)));
	const isLeader = same(self, owner);
	const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	let leftForeign = false;
	const started = Date.now();
	void role;
	watchPartyInvites({ client, leader: owner, log });

	{
		while (!shouldStop()) {
			if (partyComplete(client, wanted)) {
				log("party ready: " + partyRoster(client).join(", "));
				return true;
			}
			const myParty = client.world && client.world.self && client.world.self.party;
			const inRoster = partyRoster(client).some((name) => same(name, self));
			// Left in a party by an aborted run, or in a different one: leave once, then rejoin.
			if (!leftForeign && myParty && !inRoster) {
				leftForeign = true;
				await Promise.resolve(client.party({ event: "leave" })).catch(() => null);
				await pause(300);
				continue;
			}
			if (isLeader) {
				for (const member of wanted) {
					if (same(member, self)) continue;
					if (partyRoster(client).some((name) => same(name, member))) continue;
					await Promise.resolve(client.party({ event: "invite", name: member })).catch(() => null);
				}
			} else {
				await Promise.resolve(client.party({ event: "request", name: owner })).catch(() => null);
			}
			if (Date.now() - started >= timeoutMs) {
				log("party still incomplete (" + (partyRoster(client).join(", ") || "nobody") + "; wanted " + wanted.join(", ") + "), keeping the loop alive");
				return false;
			}
			await pause(retryMs);
		}
	}
	return false;
}

/**
 * One cheap pass: invite what is missing (leader) or ask to join (member). Call it every few seconds
 * from a loop instead of blocking on ensureParty.
 */
export async function maintainParty({ client, leader, members = [] } = {}) {
	const self = selfName(client);
	if (!self) return false;
	const owner = leader || (members || [])[0] || self;
	const wanted = Array.from(new Set([owner, ...(members || [])].filter(Boolean).map(String)));
	if (partyComplete(client, wanted)) return true;
	if (same(self, owner)) {
		for (const member of wanted) {
			if (same(member, self)) continue;
			if (partyRoster(client).some((name) => same(name, member))) continue;
			await Promise.resolve(client.party({ event: "invite", name: member })).catch(() => null);
		}
	} else {
		await Promise.resolve(client.party({ event: "request", name: owner })).catch(() => null);
	}
	return false;
}

/** Party chat (server: say with party: true reaches every member, wherever they are). */
export async function partySay(client, message) {
	return client.say(message, { party: true });
}

/** A partym packet: { owner, message, id, p } - the speaker plus the text. */
export function parsePartyChat(data) {
	if (!data || typeof data.message !== "string") return null;
	return { from: data.owner || data.name || null, message: data.message, id: data.id ?? null };
}
