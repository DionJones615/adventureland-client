// Party priest: keep everyone alive, then help with the damage.
//
// The mechanics this leans on (G.skills, node/server.js):
//   partyheal   priest only, 400 mp, heals every party member (400 below level 60), 200 ms cooldown
//   heal        priest ability, shares the attack cooldown, mp_cost (5 for a priest), one target
// The priest tops its own mana up with the "mp" regen skill (socket.on("use")) so partyheal stays
// castable - without mana a priest is a spectator.

import {
	DEFAULTS,
	PARTYHEAL_MP,
	PARTY_MAINTAIN_MS,
	combatTick,
	ensureParty,
	focusTarget,
	lowestHpMember,
	maintainParty,
	makeLog,
	maybeChat,
	memberNames,
	newState,
	noteKills,
	partySettings,
	survivalTick,
	watchDamage,
} from "./lib.mjs";

export const meta = {
	name: "party-priest",
	description: "partyheal on cooldown when the group is hurt, single-target heal, mana upkeep, damage otherwise",
};

export function run(ctx) {
	const { client, log, counters, sleep, config, party, shouldStop } = ctx;
	const settings = partySettings({ party: party || (config && config.party), args: ctx.args });
	const names = memberNames(settings);
	const say = makeLog("priest", log);
	const state = newState();
	watchDamage(client, counters, state);

	return (async () => {
		say("joining the party as the healer (partyheal needs " + PARTYHEAL_MP + " mp)");
		await ensureParty({ client, log: say, leader: settings.leader, members: names, sleep, shouldStop });
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
				const hurt = lowestHpMember({ client, members: names, self, maxDistance: settings.focusChase });
				if (hurt && hurt.ratio <= settings.healBelow && Date.now() >= state.nextHealAt) {
					state.nextHealAt = Date.now() + 400;
					if (self.mp >= PARTYHEAL_MP) {
						const answer = await client.useSkill({ name: "partyheal" }).catch((error) => ({ failed: true, response: error.message }));
						if (answer && answer.failed) {
							say("partyheal refused: " + (answer.response || answer.reason || "unknown"));
						} else {
							counters.heals++;
							say("partyheal: " + Math.round(hurt.ratio * 100) + "% on " + hurt.name);
							await maybeChat(client, state, "partyheal for " + hurt.name);
						}
						await sleep(250);
						continue;
					}
					// No mana for the group heal: patch the worst member up with the cheap one.
					if (hurt.distance > 100) {
						await client
							.walkTo({ x: Math.round(hurt.entity.x), y: Math.round(hurt.entity.y), timeoutMs: 20_000 })
							.catch(() => null);
					}
					const answer = await client.useSkill({ name: "heal", id: hurt.name }).catch((error) => ({ failed: true, response: error.message }));
					if (answer && answer.failed) say("heal refused: " + (answer.response || answer.reason || "unknown"));
					else {
						counters.heals++;
						say("heal on " + hurt.name + " (" + Math.round(hurt.ratio * 100) + "%)");
					}
					await sleep(250);
					continue;
				}
				if (self.mp < PARTYHEAL_MP && Date.now() >= state.nextPotionAt) {
					state.nextPotionAt = Date.now() + 4_400;
					counters.potions++;
					await client.use("mp").catch(() => null);
					say("drinking for mana (" + Math.round(self.mp) + " mp)");
					await sleep(200);
					continue;
				}
				const focus = focusTarget({ monsters: [...client.world.monsters.values()], anchor: settings.anchor, self, avoid: state.avoid, maxDistance: settings.focusChase, allowed: settings.targets });
				const action = await combatTick(client, { counters, log: say, settings, state, focus });
				await sleep(action === "cooldown" ? 120 : DEFAULTS.tickMs);
			} catch (error) {
				counters.failures++;
				say("tick failed: " + (error && error.message ? error.message : error));
				await sleep(500);
			}
		}
		say("stopping: " + counters.heals + " heals, " + counters.attacks + " attacks");
	})();
}
