// Party merchant: the character that cannot fight, and should not.
//
// Two rules shape this loop (both from node/server.js):
//   1. a merchant's attack is refused outright (commence_attack -> reason "merchant"), and monsters
//      give a merchant no xp, so damage is not its job;
//   2. a party chest splits items by damage share, and a merchant's share is always 0 - so a merchant
//      never loots a chest. Loot reaches it as an item transfer: fighters send their bags (B.dist 400),
//      and this loop sells them at a map merchant.
//
// What it gives back is Merchant's Luck (G.skills.mluck: merchant only, level 40, 10 mp, range 320,
// one hour): the buffed character's loot can duplicate into the merchant's own bag.

import {
	DEFAULTS,
	PARTY_MAINTAIN_MS,
	inventoryFill,
	makeLog,
	maybeChat,
	memberNames,
	merchantPoint,
	newState,
	partySettings,
	partySay,
	ensureParty,
	maintainParty,
	sellableItems,
	sellAtPoint,
	sellHere,
	survivalTick,
	walkToPoint,
	watchReceipts,
} from "./lib.mjs";

export const meta = {
	name: "party-merchant",
	description: "buffs the party with Merchant's Luck, receives fighters' loot, sells it at a merchant",
};

const BUFF_EVERY_MS = 20 * 60_000;
const SALE_WINDOW_MS = 8_000;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function run(ctx) {
	const { client, log, counters, sleep, config, party, shouldStop } = ctx;
	const settings = partySettings({ party: party || (config && config.party), args: ctx.args });
	const names = memberNames(settings).filter((name) => !same(name, (client.world.self && client.world.self.id) || ""));
	const say = makeLog("merchant", log);
	const state = newState();
	let pendingSince = 0;

	watchReceipts(client, counters, (data) => {
		say("received " + (data.q || 1) + "x " + (data.item || "an item") + " from " + (data.name || "?"));
		if (!pendingSince) pendingSince = Date.now();
	});

	return (async () => {
		say("joining the party as the merchant (selling is all I can do)");
		await ensureParty({ client, log: say, leader: settings.leader, members: names, sleep, shouldStop });
		await partySay(client, "merchant " + ((client.world.self && client.world.self.id) || "") + " ready to trade").catch(() => null);

		while (!shouldStop()) {
			try {
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
				// Liquidate: the bag is full, or something sellable has been sitting here long enough
				// that the trip is worth it (a merchant with one item should still sell it).
				// With selling disabled (the live profile) nothing is holdable, so the merchant never walks
				// anywhere and never sends a sell: it just receives and keeps the bag.
				const holdable = settings.sellEnabled === false ? [] : sellableItems(self, { potionStock: settings.potionStock, keep: settings.keepSell });
				if (holdable.length && !pendingSince) pendingSince = Date.now();
				const dueForVolume = inventoryFill(self) >= settings.sellAtFill;
				const dueForLoot = pendingSince > 0 && Date.now() - pendingSince >= SALE_WINDOW_MS;
				if (dueForVolume || dueForLoot) {
					const point = sellAtPoint(client, settings);
					if (point) await walkToPoint(client, point, { within: 340, log: say });
					const result = await sellHere(client, { counters, log: say, settings });
					if (result.sold) {
						say("sold " + result.sold + " items for " + result.gold + " gold (" + counters.gold + " total)");
						await maybeChat(client, state, "merchant: " + counters.sold + " items sold, " + counters.gold + " gold");
						pendingSince = 0;
					} else if (result.left.length) {
						say("could not sell " + result.left.length + " item(s): " + (result.left[0] && result.left[0].name));
						pendingSince = 0;
					} else {
						// Nothing sellable left (only the potion reserve): stop asking until new loot arrives.
						pendingSince = 0;
					}
					await sleep(300);
					continue;
				}
				// Buff each fighter: Merchant's Luck lasts an hour, so this is a slow rotation.
				let buffed = false;
				const players = client.world.players;
				for (const name of names) {
					const next = state.nextBuffAt.get(name) || 0;
					if (Date.now() < next) continue;
					const entity = players.get(name) || [...players.values()].find((player) => player && same(player.id, name));
					if (!entity || typeof entity.x !== "number") continue;
					if (Math.hypot(entity.x - self.x, entity.y - self.y) > settings.buffRange) continue;
					state.nextBuffAt.set(name, Date.now() + BUFF_EVERY_MS);
					const answer = await client.useSkill({ name: "mluck", id: name }).catch((error) => ({ failed: true, response: error.message }));
					if (answer && answer.failed) {
						say("mluck on " + name + " refused: " + (answer.response || answer.reason || "unknown"));
						state.nextBuffAt.set(name, Date.now() + 60_000);
					} else {
						counters.buffs++;
						say("cast Merchant's Luck on " + name);
					}
					buffed = true;
					await sleep(150);
					break;
				}
				if (buffed) continue;
				// Stay with the party but out of the fight: drift back to the anchor when we wander.
				const point = merchantPoint(client, settings);
				if (point && Math.hypot(point.x - self.x, point.y - self.y) > 120) {
					await walkToPoint(client, point, { within: 100, log: say });
				}
				await sleep(DEFAULTS.tickMs);
			} catch (error) {
				counters.failures++;
				say("tick failed: " + (error && error.message ? error.message : error));
				await sleep(500);
			}
		}
		say("stopping: " + counters.received + " items received, " + counters.sold + " sold for " + counters.gold + " gold, " + counters.buffs + " buffs");
	})();
}
