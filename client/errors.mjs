// Errors the client throws. Every one carries the server's own reason string when there is one,
// because Adventure Land answers with { failed: true, reason } rather than HTTP status codes.

export class ClientError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = "ClientError";
		Object.assign(this, details);
	}
}

/** The HTTP API or the game server refused the request. */
export class ResponseError extends ClientError {
	constructor(reason, details = {}) {
		super("request failed: " + reason, Object.assign({ reason }, details));
		this.name = "ResponseError";
	}
}

/** Nobody answered (or nobody acknowledged) in time. */
export class TimeoutError extends ClientError {
	constructor(what, timeoutMs) {
		super(what + " timed out after " + timeoutMs + "ms", { timeoutMs });
		this.name = "TimeoutError";
	}
}

/** The socket is not connected, or was closed underneath the caller. */
export class DisconnectedError extends ClientError {
	constructor(reason, details = {}) {
		super("disconnected: " + (reason || "unknown"), Object.assign({ reason }, details));
		this.name = "DisconnectedError";
	}
}
