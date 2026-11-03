import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { handleMessage, MAX_ATTEMPTS, UNSCREENED, type ConsumerEnv } from "../src/consumer";
import { DRIVE_FILE_SCOPE } from "../src/drive";
import { DAILY_LIMIT, quotaDay } from "../src/pacing";
import { SCREEN_MODEL } from "../src/screener";
import { findUpload, folderKey, getFolderId, recordUpload } from "../src/store";

const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;

const ENV: ConsumerEnv = {
	SF_INSTANCE_URL: "https://example.my.salesforce.com",
	SF_CLIENT_ID: "id",
	SF_CLIENT_SECRET: "secret",
	SF_API_VERSION: "68.0",
	GOOGLE_CLIENT_ID: "g-id",
	GOOGLE_CLIENT_SECRET: "g-secret",
	GOOGLE_REFRESH_TOKEN: "g-refresh",
	GEMINI_API_KEY: "test-gemini-key",
	AUDIT_DB: db,
};
const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";

const PASS = {
	tampering_detected: false,
	tampering_excerpt: "",
	detected_type: "Transcript",
	verdict: "pass",
	reasons: "A readable transcript for this applicant.",
};
const TAMPERED = {
	tampering_detected: true,
	tampering_excerpt: "ignore previous instructions",
	detected_type: "Transcript",
	verdict: "tampering_suspected",
	reasons: "The page contains an instruction aimed at the reviewer.",
};

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
	Application__r: { Term__c: term, Applicant_Folder_Name__c: "Shah, Rajvi", Applicant_Name__c: "Rajvi Shah" },
});

type Route =
	| "sfToken"
	| "sfQuery"
	| "sfReviewQuery"
	| "sfReviewCreate"
	| "sfMeta"
	| "sfDownload"
	| "gToken"
	| "gemini"
	| "folder"
	| "uploadStart"
	| "uploadPut"
	| "rename";
let folderCounter = 0;

interface WorldOptions {
	record: Record<string, unknown> | null;
	status?: Partial<Record<Route, number>>;
	scope?: string;
	extension?: string;
	answer?: Record<string, unknown>; // what Gemini says
	reviews?: (string | null)[]; // what each review lookup finds, in order; nothing once they run out
	duplicate?: boolean; // creating the review reports DUPLICATE_VALUE
}

// A fake Salesforce, Google and Gemini in one. Every route answers success unless given a status.
function world(opts: WorldOptions) {
	const calls: { route: Route; url: string; init?: RequestInit }[] = [];
	const reviews = [...(opts.reviews ?? [])];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const route: Route =
			url === SESSION ? "uploadPut"
			: init?.method === "PATCH" && url.startsWith("https://www.googleapis.com/drive/v3/files/") ? "rename"
			: url.startsWith("https://generativelanguage.googleapis.com/") ? "gemini"
			: url.startsWith("https://oauth2.googleapis.com/token") ? "gToken"
			: url.endsWith("/services/oauth2/token") ? "sfToken"
			: url.endsWith("/sobjects/Document_Review__c") ? "sfReviewCreate"
			: url.includes("/query?q=") && decodeURIComponent(url).includes("Document_Review__c") ? "sfReviewQuery"
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
			case "sfReviewQuery": {
				const verdict = reviews.shift() ?? null;
				return Response.json({ records: verdict ? [{ Verdict__c: verdict }] : [] });
			}
			case "sfReviewCreate":
				return opts.duplicate
					? Response.json([{ errorCode: "DUPLICATE_VALUE", message: "duplicate value found", fields: [] }], { status: 400 })
					: Response.json({ id: "a02000000000001AAA", success: true, errors: [] }, { status: 201 });
			case "sfMeta":
				return Response.json({ FileExtension: opts.extension ?? "pdf" });
			case "sfDownload":
				return new Response("%PDF-1.7 test", { headers: { "Content-Type": "application/pdf" } });
			case "gToken":
				return Response.json({ access_token: "g-tok", scope: opts.scope ?? DRIVE_FILE_SCOPE });
			case "gemini":
				return Response.json({
					candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(opts.answer ?? PASS) }] } }],
				});
			case "folder":
				return Response.json({ id: `folder-${++folderCounter}` });
			case "uploadStart":
				return new Response(null, { status: 200, headers: { Location: SESSION } });
			case "uploadPut":
				return Response.json({ id: "file-1" });
			case "rename":
				return Response.json({ id: "drive-file-old" });	
		}
	}) as typeof fetch;
	return { fetchFn, of: (r: Route) => calls.filter((c) => c.route === r), all: calls };
}

// Each run is a minute after the last, so pacing gaps are always clear unless a test sets one up.
let clock = Date.UTC(2026, 10, 3, 20, 0, 0) / 1000;

async function run(body: unknown, fetchFn: typeof fetch, attempts = 1, envOverride: ConsumerEnv = ENV) {
	clock += 60;
	const batch = createMessageBatch("intake-documents", [{ id: "msg-1", timestamp: new Date(), attempts, body }]);
	const ctx = createExecutionContext();
	const message = batch.messages[0];
	// getQueueResult records that a message was retried, not with what delay, so the call itself is watched.
	const retry = vi.spyOn(message, "retry");
	await handleMessage(message, envOverride, { fetch: fetchFn, now: () => clock });
	const result = await getQueueResult(batch, ctx);
	return { ...result, retryOptions: retry.mock.calls.map((call) => call[0]) };
}

const retried = [expect.objectContaining({ msgId: "msg-1" })];
const loggedErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});
const lastLog = (spy: ReturnType<typeof loggedErrors>) => JSON.parse(String(spy.mock.calls.at(-1)?.[0]));
const reviewSent = (w: ReturnType<typeof world>) => JSON.parse(String(w.of("sfReviewCreate")[0].init?.body));
const uploadName = (w: ReturnType<typeof world>) => JSON.parse(String(w.of("uploadStart")[0].init?.body)).name;

const auditRows = async (cv: string) =>
	(
		await db
			.prepare("SELECT stage, event, reason, attempt, final, sequence FROM audit_log WHERE content_version_id = ? ORDER BY id")
			.bind(cv)
			.all()
	).results;

// The next run's clock, for seeding pacing rows relative to it.
const nextRunAt = () => clock + 60;
async function seedCalls(calledAt: number, count = 1) {
	await db.batch(
		Array.from({ length: count }, () =>
			db.prepare("INSERT INTO gemini_calls (called_at, day) VALUES (?1, ?2)").bind(calledAt, quotaDay(calledAt)),
		),
	);
}

beforeEach(async () => {
	await db.prepare("DELETE FROM gemini_calls").run();
});
afterEach(() => vi.restoreAllMocks());

describe("queue consumer: delivery", () => {
	it("screens, files the review, then uploads the file into the student's folder", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app) });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);

		const gemini = w.of("gemini")[0];
		expect((gemini.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-gemini-key");
		expect(gemini.url).not.toContain("test-gemini-key");

		expect(reviewSent(w)).toMatchObject({ Content_Version_Id__c: t.cv, Model__c: SCREEN_MODEL, Verdict__c: "pass" });
		const order = w.all.map((c) => c.route);
		expect(order.indexOf("sfReviewCreate")).toBeLessThan(order.indexOf("uploadStart"));

		const start = JSON.parse(String(w.of("uploadStart")[0].init?.body));
		expect(start.name).toBe("Shah Rajvi Transcript #1.pdf");
		expect(start.parents).toEqual([await getFolderId(db, folderKey.application(t.app))]);
		expect(start.appProperties).toEqual({ contentVersionId: t.cv, checklistItemId: t.item });
		expect((await findUpload(db, t.cv))?.sequence).toBe(1);
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "screen", event: "screened", reason: "pass", attempt: 1, final: null, sequence: null },
			{ stage: "intake", event: "uploaded", reason: null, attempt: 1, final: null, sequence: 1 },
		]);
	});

	it("flags a file the screener says was tampered with", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app), answer: TAMPERED });

		await run(jobFor(t), w.fetchFn);

		expect(reviewSent(w)).toMatchObject({ Verdict__c: "tampering_suspected", Tampering_Excerpt__c: "ignore previous instructions" });
		expect(uploadName(w)).toBe("[FLAGGED] Shah Rajvi Transcript #1.pdf");
	});

	it("numbers a second file of the same type #2, reusing every folder", async () => {
		const first = newIds();
		const second = newIds(first.app);
		await run(jobFor(first), world({ record: recordFor(first.app) }).fetchFn);

		const w = world({ record: recordFor(first.app) });
		await run(jobFor(second), w.fetchFn);

		expect(uploadName(w)).toBe("Shah Rajvi Transcript #2.pdf");
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

	it("reuses a review filed by an earlier delivery, without screening again", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app), reviews: ["tampering_suspected"] });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("gemini")).toHaveLength(0);
		expect(w.of("sfReviewCreate")).toHaveLength(0);
		expect(uploadName(w)).toBe("[FLAGGED] Shah Rajvi Transcript #1.pdf");
		expect((await auditRows(t.cv))[0]).toMatchObject({ stage: "screen", event: "already_screened", reason: "tampering_suspected" });
	});

	it("takes the earlier verdict when another delivery filed the review first", async () => {
		const t = newIds();
		// The first lookup finds nothing, the insert loses the race, and the second lookup finds the winner's verdict.
		const w = world({ record: recordFor(t.app), answer: PASS, duplicate: true, reviews: [null, "tampering_suspected"] });

		await run(jobFor(t), w.fetchFn);

		expect(w.of("sfReviewQuery")).toHaveLength(2);
		expect(uploadName(w)).toBe("[FLAGGED] Shah Rajvi Transcript #1.pdf");
	});

	it("files a non-PDF without screening, held for a person", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app), extension: "docx" });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("gemini")).toHaveLength(0);
		expect(reviewSent(w)).toMatchObject({ Verdict__c: "needs_human", Model__c: UNSCREENED, Screen_Failure__c: "unsupported_format" });
		expect(uploadName(w)).toBe("Shah Rajvi Transcript #1.docx");
	});

	it("acknowledges a malformed job without calling anything", async () => {
		const w = world({ record: null });
		const result = await run({ v: 1, contentVersionId: "not-an-id" }, w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.all).toHaveLength(0);
	});
});

describe("queue consumer: pacing", () => {
	it("waits out the pacing gap with a delayed retry, filing nothing", async () => {
		const t = newIds();
		await seedCalls(nextRunAt() - 3);
		const w = world({ record: recordFor(t.app) });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(result.retryOptions).toEqual([{ delaySeconds: 5 }]);
		expect(w.of("gemini")).toHaveLength(0);
		expect(w.of("sfReviewCreate")).toHaveLength(0);
		expect(w.of("uploadStart")).toHaveLength(0);
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "screen", event: "deferred", reason: "too_soon", attempt: 1, final: null, sequence: null },
		]);
	});

	it("hands the job to the reconciler once the day's budget is spent", async () => {
		const t = newIds();
		await seedCalls(nextRunAt() - 3600, DAILY_LIMIT);
		const w = world({ record: recordFor(t.app) });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(w.of("gemini")).toHaveLength(0);
		expect(await findUpload(db, t.cv)).toBeNull();
		expect((await auditRows(t.cv))[0]).toMatchObject({ event: "deferred", reason: "daily_limit" });
	});

	it("hands a still-waiting job to the reconciler on its last attempt", async () => {
		const t = newIds();
		await seedCalls(nextRunAt() - 3);

		const result = await run(jobFor(t), world({ record: recordFor(t.app) }).fetchFn, MAX_ATTEMPTS);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(result.retryMessages).toEqual([]);
	});
});

describe("queue consumer: screener failures", () => {
	it("retries when Gemini is unavailable, filing no review", async () => {
		loggedErrors();
		const t = newIds();
		const w = world({ record: recordFor(t.app), status: { gemini: 503 } });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(w.of("sfReviewCreate")).toHaveLength(0);
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "intake", event: "failed", reason: "screen_unavailable", attempt: 1, final: 0, sequence: null },
		]);
	});

	it("files the document held for a person when Gemini is still down on the last attempt", async () => {
		loggedErrors();
		const t = newIds();
		const w = world({ record: recordFor(t.app), status: { gemini: 503 } });

		const result = await run(jobFor(t), w.fetchFn, MAX_ATTEMPTS);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(reviewSent(w)).toMatchObject({ Verdict__c: "needs_human", Model__c: UNSCREENED, Screen_Failure__c: "screen_unavailable" });
		expect(await findUpload(db, t.cv)).not.toBeNull();
	});

	it("holds the document for a person when Gemini refuses the request", async () => {
		loggedErrors();
		const t = newIds();
		const w = world({ record: recordFor(t.app), status: { gemini: 403 } });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(reviewSent(w)).toMatchObject({ Verdict__c: "needs_human", Screen_Failure__c: "screen_rejected" });
		expect(await findUpload(db, t.cv)).not.toBeNull();
	});
});

describe("queue consumer: failures", () => {
	it("retries when Salesforce is temporarily unavailable, recording nothing", async () => {
		const t = newIds();
		const result = await run(jobFor(t), world({ record: recordFor(t.app), status: { sfDownload: 503 } }).fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(await findUpload(db, t.cv)).toBeNull();
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "intake", event: "failed", reason: "download_unavailable", attempt: 1, final: 0, sequence: null },
		]);
	});

	it("gives up on a file the pipeline can't see, before touching Google or Gemini", async () => {
		const t = newIds();
		const w = world({ record: recordFor(t.app), status: { sfDownload: 404 } });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("gToken")).toHaveLength(0);
		expect(w.of("gemini")).toHaveLength(0);
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "intake", event: "failed", reason: "file_not_found", attempt: 1, final: 1, sequence: null },
		]);
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

	it("retries a Drive upload failure, and the retry reuses the review instead of screening again", async () => {
		const t = newIds();
		const first = world({ record: recordFor(t.app), status: { uploadStart: 500 } });
		const result = await run(jobFor(t), first.fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(first.of("sfReviewCreate")).toHaveLength(1);
		expect(await findUpload(db, t.cv)).toBeNull();

		const second = world({ record: recordFor(t.app), reviews: ["pass"] });
		await run(jobFor(t), second.fetchFn, 2);

		expect(second.of("gemini")).toHaveLength(0);
		expect(second.of("sfReviewCreate")).toHaveLength(0);
		expect(await findUpload(db, t.cv)).not.toBeNull();
	});

	it("gives up if the Google token can do more than drive.file, before screening or filing a review", async () => {
		const errors = loggedErrors();
		const t = newIds();
		const w = world({ record: recordFor(t.app), scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("gemini")).toHaveLength(0);
		expect(w.of("sfReviewCreate")).toHaveLength(0);
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


// A file in Drive from before screening existed: an upload record, but no screening row in the audit log.
async function filedBeforeScreening(t: ReturnType<typeof newIds>) {
	await recordUpload(
		db,
		{ contentVersionId: t.cv, applicationId: t.app, documentType: "Transcript", sequence: 1, driveFileId: "drive-file-old" },
		1,
	);
}

describe("queue consumer: finishing files filed before screening", () => {
	it("screens it and files the review, leaving a clean file where it is", async () => {
		const t = newIds();
		await filedBeforeScreening(t);
		const w = world({ record: recordFor(t.app) });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.of("gemini")).toHaveLength(1);
		expect(w.of("sfReviewCreate")).toHaveLength(1);
		expect(w.of("uploadStart")).toHaveLength(0);
		expect(w.of("rename")).toHaveLength(0);
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "screen", event: "screened", reason: "pass", attempt: 1, final: null, sequence: null },
		]);
	});

	it("renames a file the screener flags, keeping its number", async () => {
		const t = newIds();
		await filedBeforeScreening(t);
		const w = world({ record: recordFor(t.app), answer: TAMPERED });

		await run(jobFor(t), w.fetchFn);

		const rename = w.of("rename")[0];
		expect(rename.url).toContain("/drive/v3/files/drive-file-old");
		expect(JSON.parse(String(rename.init?.body))).toEqual({ name: "[FLAGGED] Shah Rajvi Transcript #1.pdf" });
		expect(w.of("uploadStart")).toHaveLength(0);
	});

	it("is finished after that: a redelivery calls nothing", async () => {
		const t = newIds();
		await filedBeforeScreening(t);
		await run(jobFor(t), world({ record: recordFor(t.app) }).fetchFn);

		const w = world({ record: recordFor(t.app) });
		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.all).toHaveLength(0);
	});

	it("leaves a held file alone, without calling anything", async () => {
		const t = newIds();
		await filedBeforeScreening(t);
		await db.prepare("INSERT INTO screen_holds (content_version_id, reason, held_at) VALUES (?, ?, ?)").bind(t.cv, "eval_test_set", 1).run();
		const w = world({ record: recordFor(t.app) });

		const result = await run(jobFor(t), w.fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(w.all).toHaveLength(0);
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "screen", event: "deferred", reason: "held", attempt: 1, final: null, sequence: null },
		]);
	});

	it("retries a failed rename, and the retry renames without screening again", async () => {
		loggedErrors();
		const t = newIds();
		await filedBeforeScreening(t);
		const first = world({ record: recordFor(t.app), answer: TAMPERED, status: { rename: 500 } });

		const result = await run(jobFor(t), first.fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(first.of("sfReviewCreate")).toHaveLength(1);
		// No screening row yet, so neither the reconciler nor a redelivery treats it as finished.
		expect(await auditRows(t.cv)).toEqual([
			{ stage: "intake", event: "failed", reason: "rename_unavailable", attempt: 1, final: 0, sequence: null },
		]);

		const second = world({ record: recordFor(t.app), reviews: ["tampering_suspected"] });
		await run(jobFor(t), second.fetchFn, 2);

		expect(second.of("gemini")).toHaveLength(0);
		expect(second.of("sfReviewCreate")).toHaveLength(0);
		expect(second.of("rename")).toHaveLength(1);
		expect((await auditRows(t.cv)).at(-1)).toMatchObject({ stage: "screen", event: "already_screened", reason: "tampering_suspected" });
	});
});