// Append-only job history in D1. Best-effort by design: a failed audit write is logged,
// but never blocks an upload or turns a success into a retry.

export type AuditEvent = "queued" | "uploaded" | "already_uploaded" | "failed";

export interface AuditEntry {
	contentVersionId: string;
	checklistItemId: string;
	event: AuditEvent;
	reason?: string;
	attempt?: number;
	final?: boolean;
	sequence?: number;
}

export async function audit(db: D1Database, entry: AuditEntry): Promise<boolean> {
	try {
		await db
			.prepare(
				"INSERT INTO audit_log (content_version_id, checklist_item_id, event, reason, attempt, final, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				entry.contentVersionId,
				entry.checklistItemId,
				entry.event,
				entry.reason ?? null,
				entry.attempt ?? null,
				entry.final === undefined ? null : entry.final ? 1 : 0,
				entry.sequence ?? null,
			)
			.run();
		return true;
	} catch {
		console.error(JSON.stringify({ event: "audit_write_failed", auditEvent: entry.event, contentVersionId: entry.contentVersionId }));
		return false;
	}
}