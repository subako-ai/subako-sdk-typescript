/** Reading an audit log entry's action and details. */

import * as api from "./generated/index.js";

/**
 * What an audit log entry records, as this version of the SDK knows it:
 *
 * - `event`: a recorded action this version knows, its `details` typed by its `action`;
 * - `denied`: an attempt a missing permission refused, which carries no details;
 * - `unknown`: an action recorded by a newer Core than this SDK knows, with its details as sent.
 */
export type AuditEntryEvent =
	| { kind: "event"; event: api.AuditEvent }
	| { kind: "denied"; action: string }
	| { kind: "unknown"; action: string; details: { [key: string]: unknown } };

const KNOWN: ReadonlySet<string> = new Set(Object.values(api.KnownAuditAction));

/**
 * Narrows `entry` to what it records. The action list is open: Core may record actions this SDK
 * does not know yet, which come back as `unknown` rather than being forced into a known shape.
 */
export function auditEventOf(entry: api.AuditLogEntryBody): AuditEntryEvent {
	switch (entry.result) {
		case "denied":
			return { kind: "denied", action: entry.action };
		case "success":
			return KNOWN.has(entry.action)
				? // The server writes each known action's details in its documented shape.
					{ kind: "event", event: { action: entry.action, details: entry.details } as api.AuditEvent }
				: { kind: "unknown", action: entry.action, details: entry.details };
		default: {
			const unreachable: never = entry.result;
			return { kind: "unknown", action: (unreachable as api.AuditLogEntryBody).action, details: {} };
		}
	}
}
