// Append-only job history in D1. Writes are best-effort by design: a failed audit write is logged,
// but never blocks an upload or turns a success into a retry.
export type AuditEvent = "queued" | "uploaded" | "already_uploaded" | "failed" | "screened" | "already_screened" | "deferred";

export interface AuditEntry {
	contentVersionId: string;
	checklistItemId: string;
	stage?: "intake" | "screen"; // intake when omitted, matching the column default
	event: AuditEvent;
	reason?: string;
	attempt?: number;
	final?: boolean;
	sequence?: number;
	model?: string;
}

function insert(db: D1Database, entry: AuditEntry): D1PreparedStatement {
	return db
		.prepare(
			"INSERT INTO audit_log (content_version_id, checklist_item_id, stage, event, reason, attempt, final, sequence, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			entry.contentVersionId,
			entry.checklistItemId,
			entry.stage ?? "intake",
			entry.event,
			entry.reason ?? null,
			entry.attempt ?? null,
			entry.final === undefined ? null : entry.final ? 1 : 0,
			entry.sequence ?? null,
			entry.model ?? null,
		);
}

export async function audit(db: D1Database, entry: AuditEntry): Promise<boolean> {
	try {
		await insert(db, entry).run();
		return true;
	} catch {
		console.error(JSON.stringify({ event: "audit_write_failed", auditEvent: entry.event, contentVersionId: entry.contentVersionId }));
		return false;
	}
}

// Many rows in one D1 call (and one transaction), for the reconciler's batches.
export async function auditMany(db: D1Database, entries: AuditEntry[]): Promise<boolean> {
	if (entries.length === 0) return true;
	try {
		await db.batch(entries.map((entry) => insert(db, entry)));
		return true;
	} catch {
		console.error(JSON.stringify({ event: "audit_write_failed", auditEvent: entries[0].event, count: entries.length }));
		return false;
	}
}

// Versions the consumer gave up on. Not best-effort: if this read fails, the reconciler shouldn't guess.
export async function givenUpVersions(db: D1Database): Promise<Set<string>> {
	const { results } = await db
		.prepare("SELECT DISTINCT content_version_id FROM audit_log WHERE event = 'failed' AND final = 1")
		.all<{ content_version_id: string }>();
	return new Set(results.map((r) => r.content_version_id));
}