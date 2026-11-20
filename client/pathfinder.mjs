// Movement planning against the map's geometry.
//
// A map is not a tile grid: collision is a set of wall segments (G.geometry[map].x_lines are vertical
// walls as [x, y1, y2], y_lines are horizontal ones as [y, x1, x2]). canMove() reimplements the
// segment test the game itself uses (js/old_common_functions.js can_move), and the A* below walks a
// 10px lattice whose edges are validated with it, so a planned path is one the server will accept.

const EPS = 0.01;

export class Pathfinder {
	constructor(G, { step = 10, radius = 8, maxNodes = 40_000 } = {}) {
		this.G = G;
		this.step = step;
		this.radius = radius;
		this.maxNodes = maxNodes;
		this.geometry = new Map();
	}

	geo(map) {
		if (!this.geometry.has(map)) {
			const geometry = (this.G.geometry && this.G.geometry[map]) || {};
			this.geometry.set(map, {
				x_lines: geometry.x_lines || [],
				y_lines: geometry.y_lines || [],
				min_x: geometry.min_x ?? -2000,
				min_y: geometry.min_y ?? -2000,
				max_x: geometry.max_x ?? 2000,
				max_y: geometry.max_y ?? 2000,
			});
		}
		return this.geometry.get(map);
	}

	/** Point-to-point segment test, mirroring the game's own wall check. */
	canMove(map, x0, y0, x1, y1) {
		const geo = this.geo(map);
		const minx = Math.min(x0, x1);
		const maxx = Math.max(x0, x1);
		const miny = Math.min(y0, y1);
		const maxy = Math.max(y0, y1);

		for (const line of geo.x_lines) {
			const [lx, ly1, ly2] = line;
			if (lx === x1 && ((ly1 <= y1 && ly2 >= y1) || (lx === x0 && y0 <= ly1 && y1 > ly1))) return false;
			if (minx > lx) continue;
			if (maxx < lx) break;
			const next = y0 + ((y1 - y0) * (lx - x0)) / (x1 - x0 + EPS);
			if (!(ly1 - EPS <= next && next <= ly2 + EPS)) continue;
			return false;
		}
		for (const line of geo.y_lines) {
			const [ly, lx1, lx2] = line;
			if (ly === y1 && ((lx1 <= x1 && lx2 >= x1) || (ly === y0 && x0 <= lx1 && x1 > lx1))) return false;
			if (miny > ly) continue;
			if (maxy < ly) break;
			const next = x0 + ((x1 - x0) * (ly - y0)) / (y1 - y0 + EPS);
			if (!(lx1 - EPS <= next && next <= lx2 + EPS)) continue;
			return false;
		}
		return true;
	}

	/**
	 * canMove with the character's width taken into account: the movement is repeated for points
	 * offset perpendicular to the direction of travel, which is a cheap approximation of the game's
	 * rectangle sweep.
	 */
	canWalk(map, from, to) {
		if (!this.canMove(map, from.x, from.y, to.x, to.y)) return false;
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const length = Math.hypot(dx, dy);
		if (!length) return true;
		const nx = -dy / length;
		const ny = dx / length;
		for (const offset of [-this.radius, this.radius]) {
			const ax = from.x + nx * offset;
			const ay = from.y + ny * offset;
			const bx = to.x + nx * offset;
			const by = to.y + ny * offset;
			if (!this.canMove(map, ax, ay, bx, by)) return false;
		}
		return true;
	}

	_snap(value) {
		return Math.round(value / this.step) * this.step;
	}

	key(x, y) {
		return x + "|" + y;
	}

	/**
	 * A* over the collision-free lattice.
	 * @returns {{x: number, y: number}[] | null} points from (excluding) start to target
	 */
	path(map, from, to, { maxNodes = this.maxNodes } = {}) {
		const start = { x: this._snap(from.x), y: this._snap(from.y) };
		let goal = { x: this._snap(to.x), y: this._snap(to.y) };
		if (!this.canWalk(map, from, start)) {
			// The start may sit inside a wall margin; try the nearest free lattice point instead.
			const free = this.nearestWalkable(map, start, 60);
			if (!free) return null;
			start.x = free.x;
			start.y = free.y;
		}
		if (!this.canWalk(map, goal, to) || !this.canMove(map, goal.x, goal.y, goal.x, goal.y)) {
			// keep the goal as asked for; the final step is validated by the caller
		}

		const open = [{ ...start, g: 0, f: 0, parent: null }];
		const best = new Map([[this.key(start.x, start.y), 0]]);
		const closed = new Set();
		let expanded = 0;
		const heuristic = (x, y) => {
			const dx = Math.abs(x - goal.x);
			const dy = Math.abs(y - goal.y);
			return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
		};

		while (open.length) {
			open.sort((a, b) => a.f - b.f);
			const node = open.shift();
			const nodeKey = this.key(node.x, node.y);
			if (closed.has(nodeKey)) continue;
			closed.add(nodeKey);
			if (++expanded > maxNodes) return null;
			if (node.x === goal.x && node.y === goal.y) {
				const points = [];
				for (let cursor = node; cursor && cursor.parent; cursor = cursor.parent) points.push({ x: cursor.x, y: cursor.y });
				points.reverse();
				if (points.length) points[points.length - 1] = { x: to.x, y: to.y };
				return points;
			}
			const geo = this.geo(map);
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
				[1, 1],
				[1, -1],
				[-1, 1],
				[-1, -1],
			]) {
				const nx = node.x + dx * this.step;
				const ny = node.y + dy * this.step;
				if (nx < geo.min_x || ny < geo.min_y || nx > geo.max_x || ny > geo.max_y) continue;
				const nextKey = this.key(nx, ny);
				if (closed.has(nextKey)) continue;
				if (!this.canWalk(map, { x: node.x, y: node.y }, { x: nx, y: ny })) continue;
				const cost = node.g + (dx && dy ? this.step * Math.SQRT2 : this.step);
				if (cost >= (best.get(nextKey) ?? Infinity)) continue;
				best.set(nextKey, cost);
				open.push({ x: nx, y: ny, g: cost, f: cost + heuristic(nx, ny), parent: node });
			}
		}
		return null;
	}

	/** Spiral out from a point to find somewhere the character can actually stand. */
	nearestWalkable(map, point, radius = 40) {
		const step = this.step;
		for (let ring = 0; ring <= Math.ceil(radius / step); ring++) {
			for (let dx = -ring; dx <= ring; dx++) {
				for (let dy = -ring; dy <= ring; dy++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
					const candidate = { x: point.x + dx * step, y: point.y + dy * step };
					if (this.canWalk(map, point, candidate) && this.canMove(map, candidate.x, candidate.y, candidate.x, candidate.y))
						return candidate;
				}
			}
		}
		return null;
	}

	/** Straight-line reachability, handy for short hops and for tests. */
	canWalkDirect(map, from, to) {
		return this.canWalk(map, from, to);
	}
}
