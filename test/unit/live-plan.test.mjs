import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, clientArgs, parseEnvFile, parseRoles } from "../../scripts/live/party.mjs";
import { isLocalApi, partyConfig } from "../../scripts/bot/runner.mjs";

const LIVE_ENV = {
	AL_USERNAME: "someone@example.test",
	AL_PASSWORD: "secret",
	AL_API: "https://adventure.land",
	AL_SERVER: "EU I",
	AL_PARTY_ROLES: "Dion6=leader,Maion=fighter,Paion=priest,DionMerchant=merchant",
	AL_PARTY_ANCHOR: "-193,780",
	AL_PARTY_SELL_AT: "-193,680",
	AL_PARTY_TARGETS: "goo",
	AL_PARTY_SEND: "off",
	AL_PARTY_SELL: "off",
	AL_PARTY_OWN_LOOT: "1",
	AL_PARTY_MAX_DEATHS: "3",
	AL_PUBLISH: "http://127.0.0.1:7899",
};

test("an env file is read literally: comments, export, quotes, no interpolation", () => {
	const parsed = parseEnvFile(["# a comment", "", "AL_SERVER=EU I", "export AL_USERNAME=\"a@b.test\"", "AL_ANCHOR='-1,2'", "not a pair"].join(String.fromCharCode(10)));
	assert.equal(parsed.AL_SERVER, "EU I");
	assert.equal(parsed.AL_USERNAME, "a@b.test");
	assert.equal(parsed.AL_ANCHOR, "-1,2");
	assert.equal(parsed["not a pair"], undefined);
});

test("roles are Name=role pairs, and a bare name is a fighter", () => {
	assert.deepEqual(parseRoles("A=leader,B = Priest ,,C"), [
		{ name: "A", role: "leader" },
		{ name: "B", role: "priest" },
		{ name: "C", role: "fighter" },
	]);
});

test("the live profile reads its gates from the env file", () => {
	const plan = buildPlan({ args: {}, env: LIVE_ENV });
	assert.equal(plan.live, false, "--live still has to be said out loud");
	assert.equal(plan.server, "EU I");
	assert.equal(plan.leader, "Dion6");
	assert.equal(plan.merchant, "DionMerchant");
	assert.deepEqual(plan.members, ["Dion6", "Maion", "Paion", "DionMerchant"]);
	assert.equal(plan.anchor, "-193,780");
	assert.equal(plan.targets, "goo");
	assert.equal(plan.sendEnabled, false);
	assert.equal(plan.sellEnabled, false);
	assert.equal(plan.ownLoot, true);
	assert.equal(plan.maxDeaths, 3);
	assert.equal(plan.seconds, 0, "zero means run until SIGTERM");
	assert.equal(plan.publish, "http://127.0.0.1:7899");
});

test("a remote API without a server is refused before anything connects", () => {
	assert.throws(() => buildPlan({ args: {}, env: Object.assign({}, LIVE_ENV, { AL_SERVER: "" }) }), /same server/);
});

test("an unknown role is a configuration error, not a silent fighter", () => {
	assert.throws(() => buildPlan({ args: {}, env: { AL_PARTY_ROLES: "A=wizard" } }), /unknown role wizard/);
	assert.throws(() => buildPlan({ args: {}, env: {} }), /no characters/);
});

test("--hold turns every role into hold without losing the labels", () => {
	const plan = buildPlan({ args: { hold: true }, env: LIVE_ENV });
	assert.equal(plan.hold, true);
	const tank = clientArgs(plan, { name: "Dion6", role: "leader" });
	assert.equal(tank.role, "hold");
	assert.equal(tank.character, "Dion6");
});

test("per-client args carry the gates into every loop", () => {
	const plan = buildPlan({ args: {}, env: LIVE_ENV });
	const args = clientArgs(plan, { name: "Maion", role: "fighter" });
	assert.equal(args.sendEnabled, false);
	assert.equal(args.sellEnabled, false);
	assert.equal(args.ownLoot, true);
	assert.equal(args.targets, "goo");
	assert.equal(args.leader, "Dion6");
	assert.equal(args.partyMerchant, "DionMerchant");
	assert.equal(args.members, "Dion6,Maion,Paion,DionMerchant");
	assert.equal(args.live, false);
	// and the loop config turns the strings into what the loops read
	const party = partyConfig(args);
	assert.deepEqual(party.targets, ["goo"]);
	assert.equal(party.sendEnabled, false);
	assert.equal(party.sellEnabled, false);
	assert.equal(party.ownLoot, true);
	assert.deepEqual(party.anchor, { x: -193, y: 780 });
	assert.deepEqual(party.sellAt, { x: -193, y: 680 });
});

test("the local-API gate counts loopback, private addresses and compose service names", () => {
	// The compose example talks to http://al-game:8090 from inside the network: refusing that as "the
	// live game" would break the very example this repository ships.
	const local = ["http://al-game:8090", "http://127.0.0.1:8090", "http://localhost:18090", "http://10.1.2.3:8090", "http://192.168.1.9:8090", "http://172.20.0.4:8090", "http://[::1]:8090"];
	const remote = ["https://adventure.land", "https://de.adventure.land", "http://example.com", "not a url"];
	for (const api of local) assert.equal(isLocalApi(api), true, api + " is a local stack");
	for (const api of remote) assert.equal(isLocalApi(api), false, api + " is not local");
});

test("a local API needs no server, and flags override the env file", () => {
	const plan = buildPlan({ args: { api: "http://127.0.0.1:8090", roles: "A=leader,B=merchant", seconds: "120" }, env: {} });
	assert.equal(plan.server, null);
	assert.equal(plan.seconds, 120);
	assert.equal(plan.sellEnabled, true);
	assert.equal(plan.sendEnabled, true);
	assert.equal(plan.ownLoot, false);
});
