// Party fighter: the damage that follows the leader's target.
//
// Same body as leader.mjs (focus fire, chests, loot handover) - only the party role differs: a
// fighter asks to join and accepts the leader's invite instead of inviting anyone. Mixed classes are
// fine: the shared target selection does not care what a character casts, and a mage should run this
// with AL_BOT_TRANSPORT=msgpack to prove both wire formats in one party.

import { runCombatRole } from "./lib.mjs";

export const meta = {
	name: "party-fighter",
	description: "joins the leader's party, focus-fires the shared target, opens chests, hands loot to the merchant",
};

export function run(ctx) {
	return runCombatRole(ctx, { role: "fighter" });
}
