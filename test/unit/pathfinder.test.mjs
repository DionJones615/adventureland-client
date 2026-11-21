import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGameData } from "../../client/game-data.mjs";
import { Pathfinder } from "../../client/pathfinder.mjs";

// The pathfinder needs the game's map geometry (reference/game-data/raw/data.js, fetched by
// `npm run fetch-data`). Without it these tests skip instead of failing on a clean checkout.
const AL_SKIP_NO_DATA = (() => {
	try {
		loadGameData();
		return false;
	} catch {
		return true;
	}
})();
const G = AL_SKIP_NO_DATA ? null : loadGameData();
const pf = AL_SKIP_NO_DATA ? null : new Pathfinder(G, { step: 10 });
const SKIP = AL_SKIP_NO_DATA && { skip: "game data not fetched (npm run fetch-data)" };

test("canMove rejects a crossing of a known wall and allows a parallel move", SKIP, () => {
	const [x, y1, y2] = G.geometry.main.x_lines[0];
	const midY = (y1 + y2) / 2;
	assert.equal(pf.canMove("main", x - 5, midY, x + 5, midY), false, "crossing a vertical wall");
	assert.equal(pf.canMove("main", x - 5, midY, x - 5, midY + 8), true, "moving parallel to it");

	const [y, x1, x2] = G.geometry.main.y_lines[0];
	const midX = (x1 + x2) / 2;
	assert.equal(pf.canMove("main", midX, y - 5, midX, y + 5), false, "crossing a horizontal wall");
});

test("path returns a walkable route whose last point is the target", SKIP, () => {
	const path = pf.path("main", { x: -87, y: 673 }, { x: -27, y: 673 });
	assert.ok(path && path.length > 0);
	assert.deepEqual(path[path.length - 1], { x: -27, y: 673 });
	let from = { x: -87, y: 673 };
	for (const point of path) {
		assert.ok(pf.canWalk("main", from, point), "step to " + point.x + "," + point.y + " is walkable");
		from = point;
	}
});

test("pathfinding across the main map stays responsive", SKIP, () => {
	const started = Date.now();
	const path = pf.path("main", { x: -87, y: 673 }, { x: 300, y: 900 });
	const elapsed = Date.now() - started;
	assert.ok(path, "a route exists");
	assert.ok(elapsed < 5000, "took " + elapsed + "ms");
});

test("the search gives up on time, so a hopeless target cannot stall the process", SKIP, () => {
	// The party runs several sockets on this event loop: a path search that expands for seconds
	// makes every socket miss its heartbeat. A one-millisecond budget must bail out immediately.
	const started = Date.now();
	const path = pf.path("main", { x: -87, y: 673 }, { x: 2400, y: 1900 }, { maxMs: 1, maxNodes: 500_000 });
	const elapsed = Date.now() - started;
	assert.equal(path, null);
	assert.ok(elapsed < 1500, "took " + elapsed + "ms");
});

test("an unreachable target returns null instead of an invalid route", SKIP, () => {
	// Far outside the map bounds: the lattice is clamped, so there is no route to hand back.
	const path = pf.path("main", { x: -87, y: 673 }, { x: 90000, y: 90000 }, { maxNodes: 3000 });
	assert.equal(path, null);
});
