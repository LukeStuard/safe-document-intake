import { parseJob } from "./jobs";
import {
	getAccessToken,
	getJobDetails,
	downloadVersion,
	createReview,
	findReview,
	SalesforceError,
	type SalesforceEnv,
	type JobDetails,
	type DownloadedFile,
} from "./salesforce";
import { getDriveToken, uploadFile, renameFile, DriveError, type DriveEnv } from "./drive";
import { folderPath, fileName, documentLabel, LayoutError } from "./layout";
import { findUpload, nextSequence, recordUploadStatement } from "./store";
import { ensureStudentFolder } from "./deliver";
import { audit, auditStatement, isScreened, type AuditEntry } from "./audit";
import { isHeld } from "./holds";
import { callScreener, ScreenError, SCREEN_MODEL, type ScreenResult } from "./screener";
import { reserveCall } from "./pacing";

// Must match max_retries (5) in wrangler.jsonc: the first try plus five retries.
export const MAX_ATTEMPTS = 6;

// The review's model when no model answered: a non-PDF, or a screener that couldn't be reached or refused the request.
export const UNSCREENED = "unscreened";

export type ConsumerEnv = SalesforceEnv & DriveEnv & { AUDIT_DB: D1Database; GEMINI_API_KEY: string };

export interface ConsumerDeps {
	fetch: typeof fetch;
	now?: () => number; // seconds since the epoch; tests pass a clock so pacing is deterministic
}

type Ids = { contentVersionId: string; checklistItemId: string };

interface ReviewContext {
	ids: Ids;
	attempt: number;
	lastAttempt: boolean;
	now: () => number;
	sfToken: string;
	details: JobDetails;
	file: DownloadedFile;
}

// The verdict that stands for this file, and the audit row recording how it was reached.
// The row is returned, not written, so each caller writes it only once its own side (upload or rename) is done.
interface Screening {
	verdict: string;
	entry: AuditEntry;
}

// Stands in for the model's answer when the model can't or shouldn't be asked. Always goes to a person.
function heldForPerson(failure: string): ScreenResult {
	return { verdict: "needs_human", tamperingDetected: null, tamperingExcerpt: null, detectedType: null, reasons: null, failure };
}

// Known failures say whether a retry could help. Naming problems are bad data, so they never retry.
function classify(e: unknown): { reason: string; retryable: boolean } | null {
	if (e instanceof SalesforceError || e instanceof DriveError || e instanceof ScreenError) {
		return { reason: e.reason, retryable: e.retryable };
	}
	if (e instanceof LayoutError) return { reason: e.reason, retryable: false };
	return null;
}

// Finds the review already filed for this file, or screens it and files one.
// Returns null when the job was deferred for pacing; the message has then already been retried or acked.
async function findOrScreen(
	message: Message<unknown>,
	env: ConsumerEnv,
	deps: ConsumerDeps,
	c: ReviewContext,
): Promise<Screening | null> {
	const { ids, attempt, lastAttempt } = c;

	// A redelivery reuses the filed verdict, so a crash between review and filing costs neither a second
	// Gemini call nor a second, different verdict.
	const filed = await findReview(env, c.sfToken, ids.contentVersionId, deps.fetch);
	if (filed) {
		return { verdict: filed, entry: { ...ids, stage: "screen", event: "already_screened", reason: filed, attempt } };
	}

	let result: ScreenResult;
	let model = SCREEN_MODEL;

	if (c.details.fileExtension.toLowerCase() !== "pdf") {
		// Screening is PDF-only. Anything else is still filed, and held for a person.
		result = heldForPerson("unsupported_format");
		model = UNSCREENED;
	} else {
		const slot = await reserveCall(env.AUDIT_DB, c.now());
		if (!slot.ok) {
			// Waiting for a slot isn't a failure. A short wait retries the message; a spent daily budget, or a wait
			// on the last attempt, hands the job to the hourly reconciler, so waiting never uses the job up.
			console.log(JSON.stringify({ event: "job_deferred", ...ids, reason: slot.reason, retryAfterSeconds: slot.retryAfterSeconds }));
			await audit(env.AUDIT_DB, { ...ids, stage: "screen", event: "deferred", reason: slot.reason, attempt });
			if (slot.reason === "too_soon" && !lastAttempt) message.retry({ delaySeconds: slot.retryAfterSeconds });
			else message.ack();
			return null;
		}

		try {
			result = await callScreener(
				env.GEMINI_API_KEY,
				{
					pdf: new Uint8Array(c.file.bytes),
					filedType: documentLabel(c.details.item.documentType),
					applicantName: c.details.applicantName,
				},
				deps.fetch,
			);
		} catch (e) {
			// An outage retries the job. A refused request, or an outage on the last attempt, holds the
			// document for a person instead of losing it.
			if (!(e instanceof ScreenError) || (e.retryable && !lastAttempt)) throw e;
			console.error(JSON.stringify({ event: "screen_failed", ...ids, reason: e.reason, attempts: attempt }));
			result = heldForPerson(e.reason);
			model = UNSCREENED;
		}
	}

	const outcome = await createReview(env, c.sfToken, { ...ids, model, result }, deps.fetch);
	// A duplicate means an earlier delivery filed the review first. Its verdict is the one that stands.
	const verdict =
		outcome.status === "created" ? result.verdict : await findReview(env, c.sfToken, ids.contentVersionId, deps.fetch);
	if (!verdict) throw new SalesforceError("review_unavailable", true);
	return { verdict, entry: { ...ids, stage: "screen", event: "screened", reason: result.failure ?? verdict, attempt, model } };
}

export async function handleMessage(message: Message<unknown>, env: ConsumerEnv, deps: ConsumerDeps): Promise<void> {
	const job = parseJob(message.body);
	if (!job) {
		// Only our own webhook writes to this queue, so a bad message means a bug, and retrying won't fix it.
		// Log the queue's message ID, never the body.
		console.error(JSON.stringify({ event: "job_malformed", messageId: message.id }));
		message.ack();
		return;
	}

	const ids: Ids = { contentVersionId: job.contentVersionId, checklistItemId: job.checklistItemId };
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const attempt = message.attempts;
	const lastAttempt = attempt >= MAX_ATTEMPTS;

	try {
		const existing = await findUpload(env.AUDIT_DB, job.contentVersionId);
		if (existing) {
			// In Drive and screened: finished. Checked before any call, so a redelivery costs nothing.
			if (await isScreened(env.AUDIT_DB, job.contentVersionId)) {
				console.log(JSON.stringify({ event: "job_already_uploaded", ...ids, sequence: existing.sequence }));
				await audit(env.AUDIT_DB, { ...ids, event: "already_uploaded", attempt, sequence: existing.sequence });
				message.ack();
				return;
			}
			// In Drive from before screening existed, but on hold (the eval test set): left untouched.
			if (await isHeld(env.AUDIT_DB, job.contentVersionId)) {
				console.log(JSON.stringify({ event: "job_held", ...ids }));
				await audit(env.AUDIT_DB, { ...ids, stage: "screen", event: "deferred", reason: "held", attempt });
				message.ack();
				return;
			}
		}

		const sfToken = await getAccessToken(env, deps.fetch);
		const details = await getJobDetails(env, sfToken, job, deps.fetch);
		const { item, fileExtension } = details;
		folderPath(item); // Check the naming data before downloading anything, so bad data fails fast.
		const file = await downloadVersion(env, sfToken, job.contentVersionId, deps.fetch);
		// Checked before screening, so a misconfigured Google token fails before a review is filed or a Gemini call is spent.
		const driveToken = await getDriveToken(env, deps.fetch);

		// Review first, file second: the verdict is in Salesforce before the file is filed or renamed, so a flagged
		// file is never in Drive unmarked for longer than a retry.
		const screening = await findOrScreen(message, env, deps, { ids, attempt, lastAttempt, now, sfToken, details, file });
		if (!screening) return;
		const flagged = screening.verdict === "tampering_suspected";

		if (existing) {
			// Filed before screening existed: the file stays where it is, and only a flagged one is renamed.
			if (flagged) {
				const name = fileName(item.folderName, item.documentType, existing.sequence, fileExtension, true);
				await renameFile(driveToken, existing.driveFileId, name, deps.fetch);
			}
			// Written last, so a screening row means the rename is done too. The reconciler relies on that.
			await audit(env.AUDIT_DB, screening.entry);
			console.log(JSON.stringify({ event: "job_finished", ...ids, sequence: existing.sequence, flagged, attempts: attempt }));
			message.ack();
			return;
		}

		await audit(env.AUDIT_DB, screening.entry);
		const folderId = await ensureStudentFolder(env.AUDIT_DB, item, driveToken, deps.fetch, now());
		const sequence = await nextSequence(env.AUDIT_DB, item.applicationId, item.documentType);

		const driveFileId = await uploadFile(
			driveToken,
			{
				name: fileName(item.folderName, item.documentType, sequence, fileExtension, flagged),
				parentId: folderId,
				bytes: file.bytes,
				contentType: fileExtension.toLowerCase() === "pdf" ? "application/pdf" : file.contentType,
				appProperties: { contentVersionId: job.contentVersionId, checklistItemId: job.checklistItemId },
			},
			deps.fetch,
		);

		// The upload record and its audit row are written together, so they can never disagree.
		await env.AUDIT_DB.batch([
			recordUploadStatement(
				env.AUDIT_DB,
				{
					contentVersionId: job.contentVersionId,
					applicationId: item.applicationId,
					documentType: item.documentType,
					sequence,
					driveFileId,
				},
				now(),
			),
			auditStatement(env.AUDIT_DB, { ...ids, event: "uploaded", attempt, sequence }),
		]);

		console.log(JSON.stringify({ event: "job_uploaded", ...ids, sequence, flagged, bytes: file.bytes.byteLength, attempts: attempt }));
		message.ack();
	} catch (e) {
		// Anything unclassified is a bug or a surprise: retry it, and log only the error's type.
		const known = classify(e);
		const reason = known?.reason ?? "unexpected_error";
		const retryable = known?.retryable ?? true;
		const final = !retryable || lastAttempt;
		console.error(
			JSON.stringify({
				event: "job_failed",
				...ids,
				reason,
				...(known ? {} : { errorName: e instanceof Error ? e.name : typeof e }),
				retryable,
				attempts: attempt,
				final,
			}),
		);
		// Written before the retry or give-up, so the record exists even after the message leaves the 24-hour DLQ.
		await audit(env.AUDIT_DB, { ...ids, event: "failed", reason, attempt, final });
		if (retryable) message.retry();
		else message.ack();
	}
}