// Typed actions over the raw socket events.
//
// Everything here is validated server-side anyway; the point of these wrappers is (a) the payload
// shapes the game actually expects and (b) a promise that settles when the server has answered, so
// tests and callers can sequence moves and attacks instead of guessing at timing.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createActions(client) {
	const { world } = client;

	function currentMap(map) {
		const name = map || world.map;
		if (!name) throw new Error("not in a map yet");
		return name;
	}

	function position() {
		if (!world.self) throw new Error("not in a character yet");
		return { x: world.self.x, y: world.self.y };
	}

	/** Wait until the self entity reports standing at (x, y) - the server echoes every move. */
	async function waitArrival(x, y, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const self = world.self;
			if (self && Math.hypot((self.x ?? 0) - x, (self.y ?? 0) - y) <= 6) return self;
			if (self && self.moving === false && self.x === x && self.y === y) return self;
			await sleep(25);
		}
		throw new Error("did not arrive at " + x + "," + y + " within " + timeoutMs + "ms");
	}

	const actions = {
		/** One movement step (the payload the browser client sends: {x, y, going_x, going_y, m}). */
		async move({ x, y, map, wait = true, timeoutMs = 15_000 } = {}) {
			const name = currentMap(map);
			const from = position();
			const speed = world.self.speed || 100;
			const distance = Math.hypot(x - from.x, y - from.y);
			const payload = { x: from.x, y: from.y, going_x: x, going_y: y, m: world.self.m ?? 0 };
			void name;
			const entity = world.self;
			client._send("move", payload);
			if (!wait) return payload;
			// Arrival is predicted locally: the server does not echo our own position.
			const arrival = client.movement.start(entity, { x, y });
			const guard = new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("did not arrive at " + x + "," + y + " within " + timeoutMs + "ms")),
					Math.max(timeoutMs, Math.round((distance / speed) * 1000 * 3) + 2000),
				).unref?.(),
			);
			return Promise.race([arrival, guard]);
		},

		/** Plan a path with the geometry and walk it, one hop at a time. */
		async walkTo({ x, y, map, timeoutMs = 120_000 } = {}) {
			const name = currentMap(map);
			const from = position();
			const points = client.pathfinder.path(name, from, { x, y });
			if (!points) throw new Error("no path from " + from.x + "," + from.y + " to " + x + "," + y + " on " + name);
			const deadline = Date.now() + timeoutMs;
			for (const point of points) {
				if (Date.now() > deadline) throw new Error("walkTo ran out of time");
				await actions.move({ x: point.x, y: point.y, map: name, timeoutMs: Math.max(4000, deadline - Date.now()) });
			}
			return points;
		},

		/** Attack a monster or player by id. */
		async attack(id, { timeoutMs = 3000 } = {}) {
			return client.queue.push("attack", { id }, { timeoutMs, resolveOn: ["game_response"] }).catch((error) => {
				if (error.name === "TimeoutError") return null; // attacks often answer with "u" damage instead
				throw error;
			});
		},

		/** Use a skill, optionally on a target. */
		async useSkill({ name, id, x, y } = {}, { timeoutMs = 3000 } = {}) {
			const payload = { name };
			if (id !== undefined) payload.id = id;
			if (x !== undefined) payload.x = x;
			if (y !== undefined) payload.y = y;
			return client.queue.push("skill", payload, { timeoutMs }).catch((error) => {
				if (error.name === "TimeoutError") return null;
				throw error;
			});
		},

		async say(message, { timeoutMs = 3000 } = {}) {
			return client.queue.push("say", { message }, { timeoutMs }).catch((error) => {
				if (error.name === "TimeoutError") return null;
				throw error;
			});
		},

		async use(item, { timeoutMs = 3000 } = {}) {
			return client.queue.push("use", { item }, { timeoutMs });
		},

		/** Sell one inventory slot to a merchant in range (the server checks B.sell_dist). */
		async sell({ num, quantity, timeoutMs = 3000 } = {}) {
			return client.queue.push("sell", { num, quantity: quantity || 1 }, { timeoutMs });
		},

		async equip(slot, num, { timeoutMs = 3000 } = {}) {
			return client.queue.push("equip", { slot, num }, { timeoutMs });
		},

		async respawn({ timeoutMs = 5000 } = {}) {
			return client.queue.push("respawn", {}, { timeoutMs });
		},

		async sendUpdates({ timeoutMs = 5000 } = {}) {
			return client.queue.push("send_updates", {}, { timeoutMs });
		},

		async stop({ timeoutMs = 3000 } = {}) {
			return client.queue.push("stop", {}, { timeoutMs }).catch((error) => {
				if (error.name === "TimeoutError") return null;
				throw error;
			});
		},
	};

	return actions;
}
