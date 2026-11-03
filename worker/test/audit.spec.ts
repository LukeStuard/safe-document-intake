import { env } from "cloudflare:workers";
import { describe, it, expect, vi, afterEach } from "vitest";
import { audit, type AuditEvent } from "../src/audit";

const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;

afterEach(() => vi.restoreAllMocks());

describe("audit log", () => {
	it("writes one row per event with a timestamp", async () => {
		const ok = await audit(db, {
			contentVersionId: "068000000000201AAA",
			checklistItemId: "a01000000000201AAA",
			event: "failed",
			reason: "download_unavailable",
			attempt: 2,
			final: false,
		});
		expect(ok).toBe(true);

		const row = await db
			.prepare("SELECT ts, event, reason, attempt, final, sequence FROM audit_log WHERE content_version_id = ?")
			.bind("068000000000201AAA")
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({ event: "failed", reason: "download_unavailable", attempt: 2, final: 0, sequence: null });
		expect(String(row?.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("refuses an event outside the allowed list, and reports the miss instead of throwing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const ok = await audit(db, {
			contentVersionId: "068000000000202AAA",
			checklistItemId: "a01000000000202AAA",
			event: "deleted" as AuditEvent,
		});
		expect(ok).toBe(false);
	});

	it("can't be updated or deleted, even directly", async () => {
		await audit(db, { contentVersionId: "068000000000203AAA", checklistItemId: "a01000000000203AAA", event: "queued" });

		await expect(
			db.prepare("UPDATE audit_log SET event = 'uploaded' WHERE content_version_id = ?").bind("068000000000203AAA").run(),
		).rejects.toThrow(/append-only/);
		await expect(
			db.prepare("DELETE FROM audit_log WHERE content_version_id = ?").bind("068000000000203AAA").run(),
		).rejects.toThrow(/append-only/);
	});

	it("survives a broken database, logging only the event and record ID", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const broken = {
			prepare() {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;

		const ok = await audit(broken, { contentVersionId: "068000000000204AAA", checklistItemId: "a01000000000204AAA", event: "queued" });

		expect(ok).toBe(false);
		expect(JSON.parse(String(errors.mock.calls[0][0]))).toEqual({
			event: "audit_write_failed",
			auditEvent: "queued",
			contentVersionId: "068000000000204AAA",
		});
	});
    	it("records intake events as stage 'intake' without being told", async () => {
		await audit(db, { contentVersionId: "068000000000205AAA", checklistItemId: "a01000000000205AAA", event: "queued" });
		const row = await db.prepare("SELECT stage, model FROM audit_log WHERE content_version_id = ?").bind("068000000000205AAA").first();
		expect(row).toEqual({ stage: "intake", model: null });
	});

	it("records screening events with their stage and model", async () => {
		const ok = await audit(db, {
			contentVersionId: "068000000000206AAA",
			checklistItemId: "a01000000000206AAA",
			stage: "screen",
			event: "screened",
			attempt: 1,
			model: "gemini-3.5-flash-lite",
		});
		expect(ok).toBe(true);
		const row = await db
			.prepare("SELECT stage, event, model FROM audit_log WHERE content_version_id = ?")
			.bind("068000000000206AAA")
			.first();
		expect(row).toEqual({ stage: "screen", event: "screened", model: "gemini-3.5-flash-lite" });
	});
});