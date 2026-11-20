// Selling: which merchant to walk to, and how to get the bag sold.
//
// Kept out of bot.mjs so the retry behaviour can be unit tested with a fake client: the server
// refuses a sale that is out of range with a resolved game_response (response: "distance",
// failed: true), which is the case the trip exists for.

/** A merchant to walk to: the map data first, then NPC entities in view, then a manual override. */
export function findMerchant(client, override) {
	if (override && Number.isFinite(override.x) && Number.isFinite(override.y)) return override;
	const map = client.G && client.G.maps ? client.G.maps[client.world.map] : null;
	const fromData = ((map && map.merchants) || []).filter((merchant) => merchant && Number.isFinite(merchant.x) && Number.isFinite(merchant.y));
	if (fromData.length) return fromData[0];
	for (const npc of (client.world.npcs || new Map()).values()) {
		if (!npc || typeof npc.x !== "number") continue;
		if (/merchant/i.test(String(npc.id)) || /merchant/i.test(String(npc.name || ""))) return { x: npc.x, y: npc.y };
	}
	return null;
}

/**
 * Sell each entry where the character stands.
 *
 * Returns what was sold, the gold gained, and the entries the server refused, so the caller can
 * walk to a merchant and try those again instead of guessing whether it is in range.
 */
export async function sellItems(client, items, log = () => {}) {
	let sold = 0;
	let gold = 0;
	const left = [];
	for (const entry of items) {
		try {
			const answer = await client.sell({ num: entry.num, quantity: entry.quantity });
			if (answer && answer.failed) {
				left.push(entry);
				log("sell " + entry.name + " refused: " + answer.response);
				continue;
			}
			sold++;
			gold += (answer && answer.gold) || 0;
		} catch (error) {
			left.push(entry);
			log("sell " + entry.name + " failed: " + error.message);
		}
	}
	return { sold, gold, left };
}
