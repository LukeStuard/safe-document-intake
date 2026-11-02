import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleMessage, MAX_ATTEMPTS, type ConsumerEnv } from "../src/consumer";
import { DRIVE_FILE_SCOPE } from "../src/drive";
import { findUpload, folderKey, getFolderId } from "../src/store";


const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;

const ENV: ConsumerEnv = {
	SF_INSTANCE_URL: "https://example.my.salesforce.com",
	SF_CLIENT_ID: "id",
	SF_CLIENT_SECRET: "secret",
	SF_API_VERSION: "68.0",
	GOOGLE_CLIENT_ID: "g-id",
	GOOGLE_CLIENT_SECRET: "g-secret",
	GOOGLE_REFRESH_TOKEN: "g-refresh",
	AUDIT_DB: db,
};
const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";

// Fresh IDs per test, so tests sharing the local D1 never see each other's rows.
let counter = 100;
function newIds(app?: string) {
	counter++;
	const n = String(counter).padStart(12, "0");
	return { cv: `068${n}AAA`, item: `a01${n}AAA`, app: app ?? `a00${n}AAA` };
}
const jobFor = (t: ReturnType<typeof newIds>) => ({ v: 1, contentVersionId: t.cv, checklistItemId: t.item, acceptedAt: 1767225600 });

const recordFor = (app: string, term: string | null = "Fall 2026") => ({
	Document_Type__c: "Transcript",
	Application__c: app,
	Application__r: { Term__c: term, Applicant_Folder_Name__c: "Shah, Rajvi" },
});

type Route = "sfToken" | "sfQuery" | "sfMeta" | "sfDownload" | "gToken" | "folder" | "uploadStart" | "uploadPut";
let folderCounter = 0;

// A fake Salesforce and Google in one. Every route answers success unless given a status.
function world(opts: { record: Record<string, unknown> | null; status?: Partial<Record<Route, number>>; scope?: string }) {
	const calls: { route: Route; url: string; init?: RequestInit }[] = [];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const route: Route =
			url === SESSION ? "uploadPut"
			: url.startsWith("https://oauth2.googleapis.com/token") ? "gToken"
			: url.endsWith("/services/oauth2/token") ? "sfToken"
			: url.includes("/query?q=") ? "sfQuery"
			: url.endsWith("/VersionData") ? "sfDownload"
			: url.includes("/sobjects/ContentVersion/") ? "sfMeta"
			: url.includes("uploadType=resumable") ? "uploadStart"
			: "folder";
		calls.push({ route, url, init });

		const status = opts.status?.[route];
		if (status) return new Response(null, { status });

		switch (route) {
			case "sfToken":
				return Response.json({ access_token: "sf-tok" });
			case "sfQuery":
				return Response.json({ records: opts.record ? [opts.record] : [] });
			case "sfMeta":
				return Response.json({ FileExtension: "pdf" });
			case "sfDownload":
				return new Response("%PDF-1.7 test", { headers: { "Content-Type": "application/pdf" } });
			case "gToken":
				return Response.json({ access_token: "g-tok", scope: opts.scope ?? DRIVE_FILE_SCOPE });
			case "folder":
				return Response.json({ id: `folder-${++folderCounter}` });
			case "uploadStart":
				return new Response(null, { status: 200, headers: { Location: SESSION } });
			case "uploadPut":
				return Response.json({ id: "file-1" });
		}
	}) as typeof fetch;
	return { fetchFn, of: (r: Route) => calls.filter((c) => c.route === r), all: calls };
}

async function run(body: unknown, fetchFn: typeof fetch, attempts = 1, envOverride: ConsumerEnv = ENV) {
	const batch = createMessageBatch("intake-documents", [{ id: "msg-1", timestamp: new Date(), attempts, body }]);
	const ctx = createExecutionContext();
	await handleMessage(batch.messages[0], envOverride, { fetch: fetchFn });
	return getQueueResult(batch, ctx);
}

const retried = [expect.objectContaining({ msgId: "msg-1" })];
const loggedErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});
const lastLog = (spy: ReturnType<typeof loggedErrors>) => JSON.parse(String(spy.mock.calls.at(-1)?.[0]));

const auditRows = async (cv: string) =>
	(
		await db
			.prepare("SELECT event, reason, attempt, final, sequence FROM audit_log WHERE content_version_id = ? ORDER BY id")
			.bind(cv)
			.all()
	).results;

afterEach(() => vi.restoreAllMocks());

describe("queue consumer: delivery", () => {
	it("uploads the file into the student's folder and records it", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app) });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		const start = JSON.parse(String(w.of("uploadStart")[0].init?.body));
		expect(start.name).toBe("Shah Rajvi Transcript #1.pdf");
		expect(start.parents).toEqual([await getFolderId(db, folderKey.application(t.app))]);
		expect(start.appProperties).toEqual({ contentVersionId: t.cv, checklistItemId: t.item });
		expect((await findUpload(db, t.cv))?.sequence).toBe(1);
		expect(await auditRows(t.cv)).toEqual([{ event: "uploaded", reason: null, attempt: 1, final: null, sequence: 1 }]);
	});

	it("numbers a second file of the same type #2, reusing every folder", async () => {
		const first = newIds();
		const second = newIds(first.app);
		await run(jobFor(first), world({ record: recordFor(first.app) }).fetchFn);

		const w = world({ record: recordFor(first.app) });
		await run(jobFor(second), w.fetchFn);

		expect(JSON.parse(String(w.of("uploadStart")[0].init?.body)).name).toBe("Shah Rajvi Transcript #2.pdf");
		expect(w.of("folder")).toHaveLength(0);
	});

	it("skips a redelivered job whose file is already in Drive, without calling anything", async () => {
		const t = newIds();
		await run(jobFor(t), world({ record: recordFor(t.app) }).fetchFn);

		const w = world({ record: recordFor(t.app) });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.all).toHaveLength(0);
	});

	it("acknowledges a malformed job without calling anything", async () => {
		const w = world({ record: null });
		const result = await run({ v: 1, contentVersionId: "not-an-id" }, w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.all).toHaveLength(0);
	});
});

describe("queue consumer: failures", () => {
	it("retries when Salesforce is temporarily unavailable, recording nothing", async () => {
		const t = newIds();
		const result = await run(jobFor(t), world({ record: recordFor(t.app), status: { sfDownload: 503 } }).fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(await findUpload(db, t.cv)).toBeNull();
		expect(await auditRows(t.cv)).toEqual([
		{ event: "failed", reason: "download_unavailable", attempt: 1, final: 0, sequence: null },
		]);
	});

	it("gives up on a file the pipeline can't see, before touching Google", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app), status: { sfDownload: 404 } });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("gToken")).toHaveLength(0);
		expect(await auditRows(t.cv)).toEqual([{ event: "failed", reason: "file_not_found", attempt: 1, final: 1, sequence: null }]);
	});

	it("gives up when the checklist item can't be found, before downloading", async () => {
		const t = newIds();
		const w = world({ record: null });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("sfDownload")).toHaveLength(0);
	});

	it("gives up on unusable naming data before downloading anything", async () => {
		const errors = loggedErrors();
		const t = newIds();
		const w = world({ record: recordFor(t.app, null) });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("sfDownload")).toHaveLength(0);
		expect(lastLog(errors).reason).toBe("term_unrecognized");
	});

	it("retries a Drive upload failure, recording nothing", async () => {
		const t = newIds();
		const result = await run(jobFor(t), world({ record: recordFor(t.app), status: { uploadStart: 500 } }).fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(await findUpload(db, t.cv)).toBeNull();
	});

	it("gives up if the Google token can do more than drive.file, uploading nothing", async () => {
		const errors = loggedErrors();
		const t = newIds();
		const w = world({ record: recordFor(t.app), scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("uploadStart")).toHaveLength(0);
		expect(lastLog(errors).reason).toBe("scope_mismatch");
	});

	it("retries an unexpected error, logging only its type", async () => {
		const errors = loggedErrors();
		const t = newIds();
		const broken = { ...ENV, SF_INSTANCE_URL: undefined } as unknown as ConsumerEnv;
		const result = await run(jobFor(t), world({ record: recordFor(t.app) }).fetchFn, 1, broken);

		expect(result.retryMessages).toEqual(retried);
		const logged = lastLog(errors);
		expect(logged.reason).toBe("unexpected_error");
		expect(logged.errorName).toBe("TypeError");
		expect(Object.keys(logged)).not.toContain("message");
	});

	it("marks the last attempt as final", async () => {
		const errors = loggedErrors();
		const t = newIds();
		const fetchFn = world({ record: recordFor(t.app), status: { sfDownload: 503 } }).fetchFn;

		await run(jobFor(t), fetchFn, MAX_ATTEMPTS - 1);
		expect(lastLog(errors).final).toBe(false);
		await run(jobFor(t), fetchFn, MAX_ATTEMPTS);
		expect(lastLog(errors).final).toBe(true);
	});

	
});