// Party hold: be in the party, stay alive, do nothing else.
//
// This is the role for a first run on a real server. It proves the parts that can hurt nobody - login,
// party handshake, the entity stream, the local watch page - without a single attack, step, chest or
// item transfer. Once that is trusted, the fighting roles take over.
//
// It shares the party plumbing with the other roles (lib.mjs): ensureParty/maintainParty,
// survivalTick (regen and respawn only).

import { DEFAULTS, PARTY_MAINTAIN_MS, ensureParty, maintainParty, makeLog, maybeChat, memberNames, newState, partySettings, survivalTick, watchDamage } from "./lib.mjs";

export const meta = {
	name: "party-hold",
	description: "joins the party and stands fast: no movement, no attacks, no loot, no trade",
};

export function run(ctx) {
	const { client, log, counters, sleep, config, party, shouldStop } = ctx;
	const settings = partySettings({ party: party || (config && config.party), args: ctx.args });
	const names = memberNames(settings);
	const say = makeLog("hold", log);
	const state = newState();
	watchDamage(client, counters, state);
	let lastStatus = 0;

	return (async () => {
		say("joining the party and holding still (anchor " + (settings.anchor ? settings.anchor.x + "," + settings.anchor.y : "none") + ")");
		await ensureParty({ client, log: say, leader: settings.leader, members: names, role: "hold", sleep, shouldStop });
		await maybeChat(client, state, "holding position, watching").catch(() => null);

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
				// One status line a minute: enough to see the connection is alive in a log, not enough
				// to fill it. The watch page is the real view.
				if (Date.now() - lastStatus >= 60_000) {
					lastStatus = Date.now();
					const self = client.world.self;
					const roster = client.world.party && Array.isArray(client.world.party.list) ? client.world.party.list : [];
					if (self) say("holding at " + Math.round(self.x) + "," + Math.round(self.y) + " hp " + Math.round(self.hp) + "/" + Math.round(self.max_hp) + ", party " + roster.length + "/" + names.length);
				}
				await sleep(500);
			} catch (error) {
				counters.failures++;
				say("tick failed: " + (error && error.message ? error.message : error));
				await sleep(500);
			}
		}
		say("released: " + counters.respawns + " respawns, " + counters.potions + " regen uses, " + counters.failures + " failures");
	})();
}
