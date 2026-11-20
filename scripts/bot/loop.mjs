// The bot loop as pure decisions: no sockets, no timers, no hidden state.
//
// scripts/bot.mjs owns the I/O (login, connect, enter, actions); this module only answers
// "what should the character do next given this state", which is what makes it testable.

export const DEFAULTS = {
	/** Attack monsters within this distance (world units, the character's own scale). */
	attackRange: 190,
	/** Walk towards monsters within this distance instead of waiting for them. */
	chaseRange: 400,
	/** Walk over a drop (loot pile) within this distance. */
	lootRange: 220,
	/** Drink a health potion below this fraction of max hp. */
	lowHpRatio: 0.35,
	/** Drink a mana potion below this fraction of max mp (a mage cannot attack without mana). */
	lowMpRatio: 0.35,
	/** How far the patrol waypoints sit from the anchor point. */
	patrolRadius: 90,
	/** Say something this often, so the watcher's log keeps moving. */
	sayEveryMs: 25_000,
	sayText: "patrol",
	/** Sell the bag once it is this full (0..1 of isize). */
	vendorAt: 0.95,
	/** Keep this many of each potion when selling surplus. */
	potionStock: 20,
	/** Delay between loop ticks. */
	tickMs: 300,
};

const PATROL_DIRECTIONS = [
	[1, 0],
	[1, 1],
	[0, 1],
	[-1, 1],
	[-1, 0],
	[-1, -1],
	[0, -1],
	[1, -1],
];

/** Nearest living monster within range, skipping ids the runner has given up on. */
export function nearestMonster(monsters, self, range = Infinity, avoid = new Set()) {
	let best = null;
	for (const monster of monsters || []) {
		if (!monster || monster.dead || monster.rip) continue;
		if (avoid && avoid.has(String(monster.id))) continue;
		if (typeof monster.x !== "number" || typeof monster.y !== "number") continue;
		const distance = Math.hypot(monster.x - self.x, monster.y - self.y);
		if (distance > range) continue;
		if (!best || distance < best.distance) best = { id: monster.id, distance, monster };
	}
	return best;
}

/** A point on the patrol ring around the anchor, advancing one direction per step. */
export function patrolTarget(anchor, step = 0, radius = DEFAULTS.patrolRadius) {
	const count = PATROL_DIRECTIONS.length;
	const index = ((step % count) + count) % count;
	const [dx, dy] = PATROL_DIRECTIONS[index];
	return { x: Math.round(anchor.x + dx * radius), y: Math.round(anchor.y + dy * radius) };
}

function fraction(value, max) {
	if (typeof value !== "number" || typeof max !== "number" || !max) return null;
	return value / max;
}

export function isLowHp(self, threshold = DEFAULTS.lowHpRatio) {
	const value = fraction(self && self.hp, self && self.max_hp);
	return value !== null && value <= threshold;
}

/** A mage cannot attack without mana, so this matters as much as hp. */
export function isLowMp(self, threshold = DEFAULTS.lowMpRatio) {
	const value = fraction(self && self.mp, self && self.max_mp);
	return value !== null && value <= threshold;
}

/** Potions of one kind in the bag, most valuable first (hpot3 > hpot2 > hpot1). */
export function bestPotion(self, kind = "hpot") {
	const pattern = new RegExp("^" + kind + "[0-9]+$");
	const potions = ((self && self.items) || [])
		.map((item) => item && item.name)
		.filter((name) => typeof name === "string" && pattern.test(name));
	if (!potions.length) return null;
	potions.sort((a, b) => Number(b.replace(kind, "")) - Number(a.replace(kind, "")));
	return potions[0];
}

export function hasPotion(self, kind) {
	const pattern = new RegExp("^" + kind + "[0-9]+$");
	return ((self && self.items) || []).some((item) => item && typeof item.name === "string" && pattern.test(item.name));
}


/** Nearest drop (a corpse item pile we can walk over) within range, or null. */
export function nearestDrop(drops, self, range = Infinity) {
	let best = null;
	for (const drop of drops || []) {
		if (!drop || typeof drop.x !== "number" || typeof drop.y !== "number") continue;
		const distance = Math.hypot(drop.x - self.x, drop.y - self.y);
		if (distance > range) continue;
		if (!best || distance < best.distance) best = { id: drop.id, x: drop.x, y: drop.y, distance };
	}
	return best;
}

/** How full the bag is: used slots over capacity (self.isize, 42 on a fresh character). */
export function inventoryFill(self) {
	const items = (self && self.items) || [];
	const capacity = (self && self.isize) || items.length || 0;
	if (!capacity) return 0;
	const used = items.filter(Boolean).length;
	return used / capacity;
}

export function inventoryFull(self, threshold = 0.95) {
	return inventoryFill(self) >= threshold;
}

/**
 * What is worth selling. Loot and surplus stock go; equipped gear, the placeholder slot and the
 * first `potionStock` of each potion stay (a bot that sells its last potion is a dead bot). The
 * game sells a slot at a time, so each entry carries the slot number the server expects.
 */
export function sellableItems(self, { potionStock = DEFAULTS.potionStock } = {}) {
	const items = (self && self.items) || [];
	const equipped = Object.values((self && self.slots) || {}).map((item) => item && item.name);
	const out = [];
	items.forEach((item, num) => {
		if (!item || typeof item.name !== "string") return;
		if (item.name === "placeholder") return;
		if (equipped.includes(item.name)) return;
		if (/^[hm]pot[0-9]+$/.test(item.name)) {
			const surplus = (item.q || 1) - potionStock;
			if (surplus > 0) out.push({ num, name: item.name, quantity: surplus });
			return;
		}
		out.push({ num, name: item.name, quantity: item.q || 1 });
	});
	return out;
}

/**
 * The next thing to do. Every result is a plain object so the runner can switch on type:
 *
 *   { type: "wait" }                    no character yet
 *   { type: "respawn" }                 dead, needs respawning
 *   { type: "potion", item }            hurt, tap the health regen skill
 *   { type: "mana", item }              low mana, tap the mana regen skill
 *   { type: "loot", drop }              a drop is close enough to walk over
 *   { type: "vendor", items }           the bag is full: walk to a merchant and sell
 *   { type: "say", text }               the say timer is due
 *   { type: "idle", until }            in reach, but the attack cooldown has not expired
 *   { type: "chase", id, target }       a monster is close but out of reach
 *   { type: "attack", id, distance }    a monster is in range
 *   { type: "patrol", target }          nothing to fight, walk the ring
 *
 * `avoid` holds monster ids the runner gave up on (a target that is not taking damage, or one the
 * server keeps answering "too_far" for), so the character does not stand there swinging forever.
 */
export function decide({ self, monsters = [], drops = [], config = {}, now = Date.now(), nextSayAt = 0, anchor, step = 0, avoid, attackReadyAt = 0, focus } = {}) {
	const options = { ...DEFAULTS, ...config };
	if (!self) return { type: "wait" };
	if (self.rip || self.dead) return { type: "respawn" };

	// The server answers use("hp")/use("mp") with the regen skills (node/server.js socket.on("use"):
	// data.item == "hp" || "mp"), on a 4 second potion cooldown. Potion *items* are a different path
	// that this local build does not implement, so the loop asks for the regen skills.
	if (isLowHp(self, options.lowHpRatio)) return { type: "potion", item: "hp" };
	if (isLowMp(self, options.lowMpRatio)) return { type: "mana", item: "mp" };

	// Bag full? Go and sell before picking another fight; otherwise loot is silently lost. A bag full
	// of nothing but keepers (potions, worn gear) is not worth a trip.
	if (inventoryFull(self, options.vendorAt)) {
		const items = sellableItems(self, { potionStock: options.potionStock });
		if (items.length) return { type: "vendor", items };
	}

	// Loot before picking the next fight when a pile is close: drops rot, and the bag is what makes
	// the vendor trip worth taking.
	const drop = nearestDrop(drops, self, options.lootRange);
	if (drop && !inventoryFull(self, options.vendorAt)) return { type: "loot", drop };

	// Chatting wins over fighting once the timer is due: it costs a single tick and keeps the
	// watcher log alive during a long fight.
	if (nextSayAt && now >= nextSayAt) return { type: "say", text: options.sayText };

	// Stick with the current target: re-picking the nearest monster every tick means the damage is
	// spread over everything nearby and nothing ever dies.
	let target = null;
	if (focus) {
		const focused = (monsters || []).find((monster) => monster && String(monster.id) === String(focus) && !monster.dead && !monster.rip);
		if (focused && typeof focused.x === "number" && !(avoid && avoid.has(String(focused.id)))) {
			const distance = Math.hypot(focused.x - self.x, focused.y - self.y);
			if (distance <= options.chaseRange) target = { id: focused.id, distance, monster: focused };
		}
	}
	if (!target) target = nearestMonster(monsters, self, options.chaseRange, avoid);
	if (target) {
		const distance = Math.round(target.distance);
		// Out of reach but worth walking to: the server refuses attacks on far targets ("too_far"),
		// so approaching is the difference between a loop that fights and one that swings at air.
		if (target.distance > options.attackRange) return { type: "chase", id: target.id, distance, target: { x: Math.round(target.monster.x), y: Math.round(target.monster.y) } };
		// The server throttles attacks to the character's frequency and answers "cooldown ms=N" for
		// anything faster, so swinging every tick just wastes packets and looks frozen.
		if (attackReadyAt && now < attackReadyAt) return { type: "idle", reason: "cooldown", until: attackReadyAt };
		return { type: "attack", id: target.id, distance };
	}
	return { type: "patrol", target: patrolTarget(anchor || self, step, options.patrolRadius) };
}
