// Shared plumbing for the party loops: one combat tick, one loot tick, the merchant handover.
//
// The four roles in this directory share almost everything - login, party membership, focus fire,
// chests, selling - and differ only in what they do with it. Keeping the shared parts here means a
// role file reads like its job description.
//
// Contract: every role exports run(context) from scripts/bot.mjs, i.e.
//   { client, log, counters, sleep, config, args, party, shouldStop }
// and may export meta. See ../README.md.

import { DEFAULTS, inventoryFill, isLowHp, patrolTarget, sellableItems } from "../../scripts/bot/loop.mjs";
import { PARTY_DEFAULTS, chestsNearby, ensureParty, focusTarget, lowestHpMember, maintainParty, parseAnchor, partySay, sendPlan } from "../../scripts/bot/party.mjs";
import { findMerchant, sellItems } from "../../scripts/bot/vendor.mjs";

export { DEFAULTS, PARTY_DEFAULTS, ensureParty, focusTarget, inventoryFill, lowestHpMember, maintainParty, partySay, sellableItems };
export const CHAT_EVERY_MS = 60_000;
export const PARTY_MAINTAIN_MS = 10_000;
export const PARTYHEAL_MP = 400;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Merge the runner's party section with the defaults into the one object the loops read. */
export function partySettings({ party = null, args = null } = {}) {
	const raw = party || (args && args.party) || {};
	const anchor = parseAnchor(raw.anchor) || parseAnchor(args && args.anchor) || null;
	return {
		role: raw.role || null,
		leader: raw.leader || null,
		members: Array.isArray(raw.members) ? raw.members.slice() : [],
		merchant: raw.merchant || null,
		anchor,
		sellAt: parseAnchor(raw.sellAt) || null,
		sendAt: Number.isFinite(raw.sendAt) ? raw.sendAt : PARTY_DEFAULTS.sendAt,
		sellAtFill: Number.isFinite(raw.sellAtFill) ? raw.sellAtFill : PARTY_DEFAULTS.sellAtFill,
		healBelow: Number.isFinite(raw.healBelow) ? raw.healBelow : PARTY_DEFAULTS.healBelow,
		chestRange: PARTY_DEFAULTS.chestRange,
		focusChase: PARTY_DEFAULTS.focusChase,
		buffRange: PARTY_DEFAULTS.buffRange,
		potionStock: DEFAULTS.potionStock,
	};
}

/** Everyone the party should contain, leader first. */
export function memberNames(settings) {
	const names = [settings.leader, ...(settings.members || [])].filter(Boolean).map(String);
	return Array.from(new Set(names));
}

/** A [party:<role>] logger, so four containers' logs stay tellable apart. */
export function makeLog(role, log) {
	const label = "[party:" + (role || "member") + "] ";
	return (line) => log(label + line);
}

/** The point to sell at: the configured one, the map data, or a merchant NPC in view. */
export function sellAtPoint(client, settings) {
	return settings.sellAt || findMerchant(client, null) || null;
}

/** Where the merchant probably is: its entity when in view, else the party anchor. */
export function merchantPoint(client, settings) {
	if (!settings.merchant) return settings.anchor;
	const players = client.world.players;
	const entity = players && (players.get(settings.merchant) || [...players.values()].find((player) => player && same(player.id, settings.merchant)));
	if (entity && typeof entity.x === "number") return { x: entity.x, y: entity.y };
	return settings.anchor;
}

/** Sell everything sellable where we stand. Returns { sold, gold, left }. */
export async function sellHere(client, { counters, log = () => {}, settings }) {
	const self = client.world.self;
	if (!self) return { sold: 0, gold: 0, left: [] };
	const items = sellableItems(self, { potionStock: settings ? settings.potionStock : DEFAULTS.potionStock });
	if (!items.length) return { sold: 0, gold: 0, left: [] };
	const result = await sellItems(client, items, log);
	if (counters) {
		counters.sold += result.sold;
		counters.gold += result.gold;
	}
	return result;
}

/** Walk until we are inside sell/send range of a point (400 on both counts). */
export async function walkToPoint(client, point, { within = 340, log = () => {}, timeoutMs = 60_000 } = {}) {
	const self = client.world.self;
	if (!self || !point) return false;
	const distance = Math.hypot(point.x - self.x, point.y - self.y);
	if (distance <= within) return true;
	log("walking to " + Math.round(point.x) + "," + Math.round(point.y) + " (" + Math.round(distance) + " units)");
	try {
		await client.walkTo({ x: point.x, y: point.y, timeoutMs });
		return true;
	} catch (error) {
		log("walk failed: " + error.message);
		return false;
	}
}

/**
 * Hand loot to another character (the server allows this within B.dist = 400 on the same map).
 * Returns the entries the server refused, so the caller can fall back to selling them itself.
 */
export async function sendLoot(client, { name, entries = [], counters, log = () => {} }) {
	const left = [];
	for (const entry of entries) {
		try {
			const answer = await client.sendItem({ name, num: entry.num, q: entry.quantity || entry.q || 1 });
			if (answer && answer.failed) {
				log("send " + entry.name + " refused: " + answer.response);
				left.push(entry);
				continue;
			}
			if (counters) counters.sent++;
			log("sent " + (entry.quantity || 1) + "x " + entry.name + " to " + name);
		} catch (error) {
			log("send " + entry.name + " failed: " + error.message);
			left.push(entry);
		}
	}
	return left;
}

/** Everything a fighter would hand over right now (keeping the potion reserve). */
export function lootForMerchant(self, settings) {
	return sendPlan(self, { potionStock: settings ? settings.potionStock : DEFAULTS.potionStock });
}

/** Walk to and open the nearest loot pile. Returns true when something was opened. */
export async function openNearestChest(client, { counters, log = () => {}, range = PARTY_DEFAULTS.chestRange }) {
	const self = client.world.self;
	if (!self) return false;
	const chest = chestsNearby({ drops: [...client.world.drops.values()], self, range })[0];
	if (!chest) return false;
	// Whatever happens next, this pile is no longer a candidate: a chest someone else opened gets no
	// answer at all, and retrying it every tick would stall the loop on a timeout.
	client.world.drops.delete(chest.id);
	try {
		await client.walkTo({ x: Math.round(chest.x), y: Math.round(chest.y), timeoutMs: 30_000 });
	} catch {
		/* the pile may be gone by the time we get there; opening below decides */
	}
	const opened = await client.openChest(chest.id).catch((error) => {
		log("open_chest failed: " + error.message);
		return null;
	});
	if (opened && opened.failed) {
		log("loot refused: " + (opened.response || "unknown"));
		if (opened.response !== "loot_no_space") counters.failures++;
		return false;
	}
	if (!opened) return false;
	counters.chests++;
	log("opened a chest: " + ((opened.items || []).length) + " items, " + (opened.gold || 0) + " gold");
	return true;
}

/** Respawn when dead, drink when hurt. Returns true when it did something. */
export async function survivalTick(client, { counters, log = () => {}, state }) {
	const self = client.world.self;
	if (!self) return true;
	if (self.rip || self.dead) {
		if (Date.now() < state.nextRespawnAt) return true;
		state.nextRespawnAt = Date.now() + 10_000;
		try {
			await client.respawn();
			counters.respawns++;
			log("respawned");
		} catch (error) {
			log("respawn failed: " + error.message);
		}
		return true;
	}
	if (isLowHp(self, 0.45) && Date.now() >= state.nextPotionAt) {
		state.nextPotionAt = Date.now() + 4_400;
		counters.potions++;
		await client.use("hp").catch(() => null);
		log("drank a health potion");
		return true;
	}
	return false;
}

/**
 * Attack the shared focus target, chase it, or patrol the anchor ring.
 * Pass focus to reuse a target the caller already picked; returns the action taken.
 */
/**
 * How far this character can actually attack. The server's rule (`isTargetTooFar`) is the skill's
 * range or, for a plain attack, the character's own: 18 for a warrior, 120 for a mage. Clamping this
 * up to a "sensible" 40 makes a melee character swing at air and get `too_far` back.
 */
export function reachOf(self) {
	const range = self && Number.isFinite(self.range) ? self.range : DEFAULTS.attackRange;
	return Math.max(12, Math.round(range - 2));
}

export function inReach(monsters, self, range, avoid) {
	if (!self) return null;
	return (monsters || []).find(
		(monster) =>
			monster &&
			monster.id !== undefined &&
			!monster.dead &&
			!monster.rip &&
			typeof monster.x === "number" &&
			typeof monster.y === "number" &&
			!(avoid && avoid.has(String(monster.id))) &&
			Math.hypot(monster.x - self.x, monster.y - self.y) <= range,
	) || null;
}

export async function combatTick(client, { counters, log = () => {}, settings, state, focus }) {
	const self = client.world.self;
	if (!self || !settings.anchor) return "wait";
	const monsters = [...client.world.monsters.values()];
	const groupTarget = focus === undefined ? focusTarget({ monsters, anchor: settings.anchor, self, avoid: state.avoid, maxDistance: settings.focusChase }) : focus;
	const range = reachOf(self);
	// Something is already breathing on us: hit that instead of walking past it to the group's pick.
	const target = inReach(monsters, self, range, state.avoid) || groupTarget;
	if (target) {
		const distance = Math.hypot(target.x - self.x, target.y - self.y);
		if (distance <= range) {
			if (state.focusId !== String(target.id)) {
				state.focusId = String(target.id);
				log("engaging " + target.id + " at " + Math.round(distance) + " units");
			}
			state.attacked.add(String(target.id));
			if (Date.now() < state.nextAttackAt) return "cooldown";
			state.nextAttackAt = Date.now() + Math.round(1000 / (self.frequency || 1)) + 30;
			await client.attack(target.id).catch((error) => {
				counters.failures++;
				log("attack failed: " + error.message);
			});
			counters.attacks++;
			return "attack";
		}
		const step = { x: Math.round(target.x), y: Math.round(target.y) };
		if (client.pathfinder.canWalkDirect(client.world.map, self, step)) {
			await client.move(step).catch(() => null);
			counters.steps++;
			return "chase";
		}
		state.avoid.add(String(target.id));
		return "blocked";
	}
	const ring = patrolTarget(settings.anchor, state.step++, DEFAULTS.patrolRadius);
	if (client.pathfinder.canWalkDirect(client.world.map, self, ring)) {
		await client.move(ring).catch(() => null);
		counters.patrols++;
		return "patrol";
	}
	return "idle";
}

/** Announce a line in party chat, at most once a minute. */
export async function maybeChat(client, state, message) {
	if (Date.now() < state.nextChatAt) return;
	state.nextChatAt = Date.now() + CHAT_EVERY_MS;
	await partySay(client, message).catch(() => null);
}

/**
 * Count our own damage (the runner does this for decide() loops; a run() loop reports for itself) and
 * notice kills: a monster we hit that leaves the world without being culled by vision is dead.
 */
export function watchDamage(client, counters, state) {
	client.on("event", (name, data) => {
		const self = client.world.self;
		if (name === "hit" && data && self && String(data.hid).toLowerCase() === String(self.id).toLowerCase()) {
			counters.hits++;
			counters.damage += data.damage || 0;
		}
		if (name === "disappear" && data && data.outside && data.id !== undefined) state.culled.add(String(data.id));
	});
}

/** Fold the monsters we engaged and that are gone into counters.kills. Call once per tick. */
export function noteKills(client, counters, state) {
	for (const id of [...state.attacked]) {
		if (client.world.monsters.has(id)) continue;
		state.attacked.delete(id);
		if (state.culled.has(id)) continue;
		counters.kills++;
	}
}

/** Follow the item traffic a character receives or sends. */
export function watchReceipts(client, counters, onReceipt = () => {}) {
	client.on("event", (name, data) => {
		if (name === "game_response" && data && data.response === "item_received") {
			counters.received++;
			onReceipt(data);
		}
	});
}

/** A fresh per-role state bag (cooldowns, chat timer, avoid set). */
export function newState() {
	return {
		nextAttackAt: 0,
		nextPotionAt: 0,
		nextRespawnAt: 0,
		nextChatAt: 0,
		nextPartyAt: 0,
		nextHealAt: 0,
		nextBuffAt: new Map(),
		sellDueAt: 0,
		soldReceived: 0,
		step: 0,
		avoid: new Set(),
		attacked: new Set(),
		culled: new Set(),
		focusId: null,
	};
}

/**
 * The body of a fighting role: join the party, survive, hand loot to the merchant, open chests when
 * there is nothing to hit, and focus-fire whatever the group is hitting.
 */
export async function runCombatRole(ctx, { role = "fighter" } = {}) {
	const { client, log, counters, sleep, config, party, shouldStop } = ctx;
	const settings = partySettings({ party: party || (config && config.party), args: ctx.args });
	const names = memberNames(settings);
	const say = makeLog(role, log);
	const state = newState();
	watchReceipts(client, counters);
	watchDamage(client, counters, state);
	say("joining the party (leader " + (settings.leader || "?") + ", members " + names.join(", ") + ")");
	await ensureParty({ client, log: say, leader: settings.leader, members: names, role, sleep, shouldStop });

	while (!shouldStop()) {
		try {
			noteKills(client, counters, state);
			if (await survivalTick(client, { counters, log: say, state })) {
				await sleep(DEFAULTS.tickMs);
				continue;
			}
			if (Date.now() >= state.nextPartyAt) {
				state.nextPartyAt = Date.now() + PARTY_MAINTAIN_MS;
				await maintainParty({ client, leader: settings.leader, members: names });
			}
			const self = client.world.self;
			if (!self) {
				await sleep(DEFAULTS.tickMs);
				continue;
			}
			// The bag is filling: walk to the merchant and hand it over; if it cannot take it, sell it.
			const entries = lootForMerchant(self, settings);
			if (entries.length && inventoryFill(self) >= settings.sendAt && settings.merchant) {
				const point = merchantPoint(client, settings);
				await walkToPoint(client, point, { within: 360, log: say });
				const left = await sendLoot(client, { name: settings.merchant, entries, counters, log: say });
				if (left.length) {
					await walkToPoint(client, sellAtPoint(client, settings), { within: 340, log: say });
					const sold = await sellHere(client, { counters, log: say, settings });
					if (sold.sold) say("sold " + sold.sold + " items for " + sold.gold + " gold myself");
				}
				await maybeChat(client, state, "bag handed to " + settings.merchant + " (" + counters.sent + " sent)");
				await sleep(200);
				continue;
			}
			const focus = focusTarget({ monsters: [...client.world.monsters.values()], anchor: settings.anchor, self, avoid: state.avoid, maxDistance: settings.focusChase });
			// Loot, but never let it replace the fight: a pile under our feet is worth a step, and with
			// nothing to hit the whole ring is fair game. Chasing the group's target always comes first,
			// otherwise a melee character spends the session sweeping chests.
			if (settings.anchor) {
				const lootRange = focus ? 60 : settings.chestRange;
				if (await openNearestChest(client, { counters, log: say, range: lootRange })) {
					await sleep(120);
					continue;
				}
			}
			const action = await combatTick(client, { counters, log: say, settings, state, focus });
			await sleep(action === "cooldown" ? 120 : DEFAULTS.tickMs);
		} catch (error) {
			counters.failures++;
			say("tick failed: " + (error && error.message ? error.message : error));
			await sleep(500);
		}
	}
	say("stopping: " + counters.attacks + " attacks, " + counters.chests + " chests, " + counters.sent + " sent");
}
