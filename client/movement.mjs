// Local movement prediction.
//
// The game server does not echo a character's own position: send_xy_updates skips the receiving
// player (node/server.js send_xy_updates: "if (entity.id === player.id) continue"), and the official
// client moves itself - calculate_vxy sets a velocity, the render tick advances x/y, and the server
// only intervenes with a "correction" packet when it disagrees. A client that waits for a position
// echo waits forever, which is why this model exists.

const TICK_MS = 16;

export class MovementModel {
	constructor({ onUpdate = () => {}, tickMs = TICK_MS } = {}) {
		this.onUpdate = onUpdate;
		this.tickMs = tickMs;
		this.timer = null;
		this.entity = null;
		this.from = null;
		this.to = null;
		this.vx = 0;
		this.vy = 0;
		this.last = 0;
		this.waiters = [];
	}

	get moving() {
		return Boolean(this.timer);
	}

	/** Same velocity formula the game uses: speed spread over the distance, diagonals normalised. */
	start(entity, to) {
		if (!entity) throw new Error("no entity to move");
		this.stop({ silent: true });
		const from = { x: entity.x, y: entity.y };
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const distance = Math.hypot(dx, dy);
		if (distance < 0.001) {
			entity.x = to.x;
			entity.y = to.y;
			entity.moving = false;
			this.onUpdate(entity);
			return Promise.resolve(entity);
		}
		const speed = entity.speed || 100;
		this.entity = entity;
		this.from = from;
		this.to = { x: to.x, y: to.y };
		this.vx = (speed * dx) / distance;
		this.vy = (speed * dy) / distance;
		entity.from_x = from.x;
		entity.from_y = from.y;
		entity.going_x = to.x;
		entity.going_y = to.y;
		entity.moving = true;
		entity.angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		entity.vx = this.vx;
		entity.vy = this.vy;
		this.last = performance.now();
		const arrived = new Promise((resolve) => this.waiters.push(resolve));
		this.timer = setInterval(() => this.tick(), this.tickMs);
		this.timer.unref?.();
		return arrived;
	}

	tick(now = performance.now()) {
		if (!this.entity || !this.to) return;
		const dt = Math.min(1, (now - this.last) / 1000); // never advance more than a second at once
		this.last = now;
		const entity = this.entity;
		const dx = this.to.x - entity.x;
		const dy = this.to.y - entity.y;
		const stepX = this.vx * dt;
		const stepY = this.vy * dt;
		if (Math.abs(dx) <= Math.abs(stepX) + 0.5 && Math.abs(dy) <= Math.abs(stepY) + 0.5) {
			entity.x = this.to.x;
			entity.y = this.to.y;
			this._arrive();
			return;
		}
		entity.x += stepX;
		entity.y += stepY;
		this.onUpdate(entity);
	}

	_arrive() {
		const entity = this.entity;
		if (entity) {
			entity.moving = false;
			entity.vx = 0;
			entity.vy = 0;
		}
		const waiters = this.waiters;
		this.waiters = [];
		this.stop({ silent: true });
		this.onUpdate(entity);
		for (const resolve of waiters) resolve(entity);
	}

	/** Server disagreement: snap to where it says we are. */
	correct(x, y) {
		if (!this.entity) return;
		this.entity.x = x;
		this.entity.y = y;
		this.to = { x, y };
		this._arrive();
	}

	stop({ silent = false } = {}) {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (silent) {
			const waiters = this.waiters;
			this.waiters = [];
			for (const resolve of waiters) resolve(this.entity);
		}
		this.entity = null;
		this.to = null;
		this.vx = 0;
		this.vy = 0;
	}
}
