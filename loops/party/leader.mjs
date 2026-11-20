// Party leader: the warrior that owns the party and calls the kills.
//
// Being the leader is not a separate job - whoever the server records as the party owner invites the
// others and answers join requests (scripts/bot/party.mjs, ensureParty) - so the fighting body is
// shared with fighter.mjs. This file exists so the compose example and the logs read by role.

import { runCombatRole } from "./lib.mjs";

export const meta = {
	name: "party-leader",
	description: "owns the party, invites the members, focus-fires, opens chests, hands loot to the merchant",
};

export function run(ctx) {
	return runCombatRole(ctx, { role: "leader" });
}
