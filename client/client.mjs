// High level client: login over HTTP, then drive a character over the game socket.
//
// The connection sequence is not guessable, so this is what the server requires (node/server.js):
//   connect  -> server emits "welcome" (observer view, no character)
//            -> client emits "loaded"   (registers the observer; auth is refused without it)
//            -> client emits "auth"     ({user, character, auth})
//            -> server emits "player"   (the character) followed by "entities"
// A second "welcome" never comes: "player" is the in-game signal.

import { EventEmitter } from "node:events";
import { AccountApi } from "./http.mjs";
import { createActions } from "./actions.mjs";
import { ClientError, DisconnectedError, ResponseError, TimeoutError } from "./errors.mjs";
import { loadGameData } from "./game-data.mjs";
import { MovementModel } from "./movement.mjs";
import { Pathfinder } from "./pathfinder.mjs";
import { RequestQueue } from "./queue.mjs";
import { GameSocket } from "./transport/socket.mjs";
import { World } from "./world.mjs";

export class ALClient extends EventEmitter {
	constructor({ apiBaseUrl = "http://127.0.0.1:8090", gameDataFile, intervals, requestTimeoutMs = 15_000, logger = console } = {}) {
		super();
		this.apiBaseUrl = apiBaseUrl;
		this.api = new AccountApi({ baseUrl: apiBaseUrl });
		this.world = new World();
		this.world.on("missing-delta-base", () => this.actions.sendUpdates().catch(() => {}));
		this.logger = logger;
		this.requestTimeoutMs = requestTimeoutMs;
		this.socket = null;
		this.server = null;
		this.character = null;
		this.gameDataFile = gameDataFile;
		this._G = null;
		this._pathfinder = null;
		this.queue = new RequestQueue({
			send: (event, data) => this._send(event, data),
			intervals,
			defaultTimeoutMs: requestTimeoutMs,
		});
		// The server never echoes our own position; movement is predicted locally and corrected by
		// the "correction" packet when the two disagree.
		this.movement = new MovementModel({ onUpdate: (entity) => this.emit("self", entity) });
		this.actions = createActions(this);
	}

	get G() {
		this._G ||= loadGameData(this.gameDataFile);
		return this._G;
	}

	get pathfinder() {
		this._pathfinder ||= new Pathfinder(this.G);
		return this._pathfinder;
	}

	get connected() {
		return Boolean(this.socket && this.socket.connected);
	}

	get self() {
		return this.world.self;
	}

	// ---- account (HTTP) -------------------------------------------------------

	async login({ email, password, onlyLogin = false } = {}) {
		this.session = await this.api.signupOrLogin({ email, password, onlyLogin });
		return this.session;
	}

	async servers() {
		const { servers } = await this.api.serversAndCharacters();
		return servers || [];
	}

	async characters() {
		return this.api.characterList();
	}

	async createCharacter({ name, char: charType = "mage", look = 0, connect = false } = {}) {
		const body = await this.api.createCharacter({ name, char: charType, look });
		if (connect) await this.connect();
		return body;
	}

	// ---- socket --------------------------------------------------------------

	_addressWithScheme(address) {
		if (/^https?:\/\//.test(address)) return address;
		const scheme = /^https:/i.test(this.apiBaseUrl) ? "https://" : "http://";
		return scheme + address;
	}

	async _resolveServer(server, { address, path, msgpackPath } = {}) {
		if (address) return { address: this._addressWithScheme(address), path: path || "/socket.io/", msgpack_path: msgpackPath };
		if (server && typeof server === "object") {
			return {
				address: this._addressWithScheme(server.address),
				path: server.path || path || "/socket.io/",
				msgpack_path: server.msgpack_path || msgpackPath,
			};
		}
		const list = await this.servers();
		if (!list.length) throw new ClientError("the account API returned no game servers");
		const wanted = typeof server === "string" ? server.toLowerCase() : null;
		const found = wanted
			? list.find((entry) => (entry.region + " " + entry.name).toLowerCase() === wanted || entry.name.toLowerCase() === wanted)
			: list.find((entry) => entry.players !== undefined) || list[0];
		if (!found) throw new ClientError("no such server: " + server + " (have " + list.map((entry) => entry.region + " " + entry.name).join(", ") + ")");
		return { address: this._addressWithScheme(found.address), path: found.path || "/socket.io/", msgpack_path: found.msgpack_path, raw: found };
	}

	async connect({ server, address, path, msgpackPath, transport = "json", query = {}, timeoutMs = 20_000 } = {}) {
		if (this.socket) throw new ClientError("already connected");
		const target = await this._resolveServer(server, { address, path, msgpackPath });
		this.server = target;
		this.socket = new GameSocket({
			address: target.address,
			path: target.path,
			msgpackPath: target.msgpack_path,
			transport,
			query,
			timeoutMs,
		});
		this.socket.onEvent = (event, data) => this._onEvent(event, data);
		this.socket.on("disconnect", (reason) => {
			this.queue.fail(reason);
			this.emit("disconnected", reason);
		});
		// Subscribe before connecting: the server sends "welcome" as the handshake completes.
		const welcome = this.socket.once("welcome", { timeoutMs, filter: (data) => Boolean(data) });
		await this.socket.connect();
		this.welcome = await welcome;
		this.emit("welcome", this.welcome);
		return this.welcome;
	}

	/** Enter the game as a character. Resolves with the self entity once the server sends "player". */
	async enter(character, { timeoutMs = 45_000, codeSlot = 0, width = 1000, height = 700, scale = 2, noGraphics = true } = {}) {
		if (!this.connected) throw new ClientError("connect() first");
		if (!this.session) throw new ClientError("login() first");
		const requested = typeof character === "string" ? character : character && (character.id || character.name);
		if (!requested) throw new ClientError("a character name is required");
		// The server wants the character document id ("CH_..."), not the display name: auth looks the
		// entity up by _id and only prefixes "CH_" when it is missing, so a plain name becomes a
		// character that does not exist (game_error: no_character).
		const name = requested;
		const list = await this.characters().catch(() => []);
		const found = list.find((entry) => entry.id === requested || entry.name === requested);
		const characterId = found ? found.id : requested;

		const payload = {
			user: this.session.user,
			character: characterId,
			code_slot: codeSlot,
			auth: this.session.auth,
			width,
			height,
			scale,
			no_html: false,
			no_graphics: noGraphics,
		};

		const settled = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new TimeoutError("character enter", timeoutMs));
			}, timeoutMs);
			const offs = [];
			const cleanup = () => {
				clearTimeout(timer);
				for (const off of offs) off();
			};
			const onPlayer = (data) => {
				if (!data) return;
				// "player" is only ever sent to a socket for its own character. Names are stored lower
				// case by simplify_name, so compare case-insensitively and fall back to the document id.
				const candidate = String(data.id || data.name || "").toLowerCase();
				const wanted = String(name).toLowerCase();
				if (candidate && wanted && candidate !== wanted && data.real_id !== characterId) return;
				cleanup();
				resolve(data);
			};
			const onError = (message) => {
				cleanup();
				const reason = typeof message === "string" ? message : message?.reason || message?.response || JSON.stringify(message);
				reject(new ResponseError(reason, { message }));
			};
			offs.push(this.socket.onGameEvent("start", onPlayer));
			offs.push(this.socket.onGameEvent("player", onPlayer));
			offs.push(this.socket.onGameEvent("game_error", onError));
			offs.push(
				this.socket.onGameEvent("disconnect_reason", (reason) => {
					cleanup();
					reject(new DisconnectedError(reason));
				}),
			);
		});

		this.socket.emit("loaded", { width, height, scale });
		this.socket.emit("auth", payload);
		const self = await settled;
		this.character = name;
		this.selfPlayer = self;
		// Ask for the complete view in case the server's entity stream started before we were ready.
		this.actions.sendUpdates({ timeoutMs: 3000 }).catch(() => {});
		return self;
	}

	_onEvent(event, data) {
		try {
			if (event === "correction" && data) this.movement.correct(data.x, data.y);
			this.world.handle(event, data);
			if (this.world.self) {
				this.world.x = this.world.self.x;
				this.world.y = this.world.self.y;
			}
		} catch (error) {
			this.emit("error", error);
		}
		try {
			this.queue.settle(event, data);
		} catch (error) {
			this.emit("error", error);
		}
		this.emit(event, data);
		this.emit("event", event, data);
	}

	_send(event, data) {
		if (!this.connected) throw new DisconnectedError("cannot send " + event);
		this.socket.emit(event, data);
	}

	/** Wait for one server event (thin wrapper, mainly for tests). */
	nextEvent(event, { timeoutMs = this.requestTimeoutMs, filter } = {}) {
		if (!this.socket) return Promise.reject(new ClientError("not connected"));
		return this.socket.once(event, { timeoutMs, filter });
	}

	disconnect() {
		this.queue.fail("client disconnect");
		this.world.reset();
		if (this.socket) this.socket.close();
		this.socket = null;
		this.welcome = null;
	}

	// Convenience pass-throughs so callers do not have to reach into .actions.
	move(options) {
		return this.actions.move(options);
	}
	walkTo(options) {
		return this.actions.walkTo(options);
	}
	attack(id, options) {
		return this.actions.attack(id, options);
	}
	useSkill(options, extra) {
		return this.actions.useSkill(options, extra);
	}
	say(message, options) {
		return this.actions.say(message, options);
	}
	use(item, options) {
		return this.actions.use(item, options);
	}
	equip(slot, num, options) {
		return this.actions.equip(slot, num, options);
	}
	sell(options) {
		return this.actions.sell(options);
	}
	respawn(options) {
		return this.actions.respawn(options);
	}
	stop(options) {
		return this.actions.stop(options);
	}
	sendUpdates(options) {
		return this.actions.sendUpdates(options);
	}
	party(options, extra) {
		return this.actions.party(options, extra);
	}
	openChest(id, options) {
		return this.actions.openChest(id, options);
	}
	sendItem(options, extra) {
		return this.actions.sendItem(options, extra);
	}
}
