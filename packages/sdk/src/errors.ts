import { ErrorCode } from "./generated/index.js";

/** What a failure carries beyond its message. */
export interface SubakoErrorInit {
	readonly status?: number;
	readonly code?: string | null;
	readonly body?: unknown;
	readonly cause?: unknown;
}

/** Base of every failure this SDK raises. */
export class SubakoError extends Error {
	/** HTTP failure status, or undefined for a transport failure. */
	readonly status: number | undefined;
	/** Code from the error envelope, or null when the body carried none. */
	readonly code: string | null;
	/** Response body, parsed when the server sent JSON. */
	readonly body: unknown;

	constructor(message: string, init: SubakoErrorInit = {}) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = new.target.name;
		this.status = init.status;
		this.code = init.code ?? null;
		this.body = init.body;
	}
}

/** The bearer token is missing, malformed, or no longer valid. */
export class UnauthorizedError extends SubakoError {
	override readonly code = ErrorCode.UNAUTHORIZED;
}

/** The caller is known but lacks the permission the route asks for. */
export class ForbiddenError extends SubakoError {
	override readonly code = ErrorCode.FORBIDDEN;
}

/** No such resource, or the caller cannot see it. */
export class NotFoundError extends SubakoError {
	override readonly code = ErrorCode.NOT_FOUND;
}

/** The request itself is malformed: a bad body, path parameter, or query. */
export class InvalidRequestError extends SubakoError {
	override readonly code = ErrorCode.INVALID_REQUEST;
}

/** The resource's state rules out the change, a key reused for a different request among them; retrying alone will not help. */
export class ConflictError extends SubakoError {
	override readonly code = ErrorCode.CONFLICT;
}

/** The server refuses this client version and asks for an upgrade. */
export class ClientOutdatedError extends SubakoError {
	override readonly code = ErrorCode.CLIENT_OUTDATED;
}

/** The server failed to handle an otherwise valid request. */
export class InternalError extends SubakoError {
	override readonly code = ErrorCode.INTERNAL;
}

/** No complete response arrived: DNS, TCP, TLS, a dropped connection, or a timeout. */
export class SubakoConnectionError extends SubakoError {
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
	}
}

/** The attempt outlived its timeout. */
export class SubakoTimeoutError extends SubakoConnectionError {}

interface Envelope {
	readonly code: string;
	readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function readEnvelope(body: unknown): Envelope | null {
	if (!isRecord(body)) {
		return null;
	}
	const detail = body["error"];
	if (!isRecord(detail)) {
		return null;
	}
	const code = detail["code"];
	const message = detail["message"];
	return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

/** The class each code names; anything else stays a plain `SubakoError`. */
const BY_CODE: Readonly<Record<string, new (message: string, init: SubakoErrorInit) => SubakoError>> = {
	[ErrorCode.UNAUTHORIZED]: UnauthorizedError,
	[ErrorCode.FORBIDDEN]: ForbiddenError,
	[ErrorCode.NOT_FOUND]: NotFoundError,
	[ErrorCode.INVALID_REQUEST]: InvalidRequestError,
	[ErrorCode.CONFLICT]: ConflictError,
	[ErrorCode.CLIENT_OUTDATED]: ClientOutdatedError,
	[ErrorCode.INTERNAL]: InternalError,
};

/** Turns a refused response into the error class its code names. */
export function toSubakoError(body: unknown, status: number): SubakoError {
	const envelope = readEnvelope(body);
	if (envelope === null) {
		const message = typeof body === "string" && body !== "" ? body : `HTTP ${status}`;
		return new SubakoError(message, { status, body });
	}
	const Failure = BY_CODE[envelope.code] ?? SubakoError;
	return new Failure(envelope.message, { status, code: envelope.code, body });
}

/** A short description of a value thrown by the transport. */
export function describeCause(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	if (typeof cause === "string") {
		return cause;
	}
	return JSON.stringify(cause) ?? "unknown error";
}
