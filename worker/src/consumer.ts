import { parseJob } from "./jobs";
import {
	getAccessToken,
	getJobDetails,
	downloadVersion,
	createReview,
	findReview,
	SalesforceError,
	type SalesforceEnv,
} from "./salesforce";
import { getDriveToken, uploadFile, DriveError, type DriveEnv } from "./drive";
import { folderPath, fileName, documentLabel, LayoutError } from "./layout";
import { findUpload, nextSequence, recordUploadStatement } from "./store";
import { ensureStudentFolder } from "./deliver";
import { audit, auditStatement } from "./audit";
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

export async function handleMessage(message: Message<unknown>, env: ConsumerEnv, deps: ConsumerDeps): Promise<void> {
	const job = parseJob(message.body);
	if (!job) {
		// Only our own webhook writes to this queue, so a bad message means a bug, and retrying won't fix it.
		// Log the queue's message ID, never the body.
		console.error(JSON.stringify({ event: "job_malformed", messageId: message.id }));
		message.ack();
		return;
	}

	const ids = { contentVersionId: job.contentVersionId, checklistItemId: job.checklistItemId };
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const attempt = message.attempts;
	const lastAttempt = attempt >= MAX_ATTEMPTS;

	try {
		// A redelivered job whose file already reached Drive is finished.
		const existing = await findUpload(env.AUDIT_DB, job.contentVersionId);
		if (existing) {
			console.log(JSON.stringify({ event: "job_already_uploaded", ...ids, sequence: existing.sequence }));
			await audit(env.AUDIT_DB, { ...ids, event: "already_uploaded", attempt, sequence: existing.sequence });
			message.ack();
			return;
		}

		const sfToken = await getAccessToken(env, deps.fetch);
		const { item, fileExtension, applicantName } = await getJobDetails(env, sfToken, job, deps.fetch);
		folderPath(item); // Check the naming data before downloading anything, so bad data fails fast.
		const file = await downloadVersion(env, sfToken, job.contentVersionId, deps.fetch);
		// Checked before screening, so a misconfigured Google token fails before a review is filed or a Gemini call is spent.
		const driveToken = await getDriveToken(env, deps.fetch);

		// Review first, file second. The verdict is in Salesforce before the file reaches Drive, so a flagged file is
		// never in Drive unmarked, and a crash between the two is finished by the next delivery with the same verdict.
		let verdict = await findReview(env, sfToken, job.contentVersionId, deps.fetch);
		if (verdict) {
			await audit(env.AUDIT_DB, { ...ids, stage: "screen", event: "already_screened", reason: verdict, attempt });
		} else {
			let result: ScreenResult;
			let model = SCREEN_MODEL;

			if (fileExtension.toLowerCase() !== "pdf") {
				// Screening is PDF-only. Anything else is still filed, and held for a person.
				result = heldForPerson("unsupported_format");
				model = UNSCREENED;
			} else {
				const slot = await reserveCall(env.AUDIT_DB, now());
				if (!slot.ok) {
					// Waiting for a slot isn't a failure. A short wait retries the message; a spent daily budget, or a wait
					// on the last attempt, hands the job to the hourly reconciler, so waiting never uses the job up.
					console.log(
						JSON.stringify({ event: "job_deferred", ...ids, reason: slot.reason, retryAfterSeconds: slot.retryAfterSeconds }),
					);
					await audit(env.AUDIT_DB, { ...ids, stage: "screen", event: "deferred", reason: slot.reason, attempt });
					if (slot.reason === "too_soon" && !lastAttempt) message.retry({ delaySeconds: slot.retryAfterSeconds });
					else message.ack();
					return;
				}

				try {
					result = await callScreener(
						env.GEMINI_API_KEY,
						{ pdf: new Uint8Array(file.bytes), filedType: documentLabel(item.documentType), applicantName },
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

			const outcome = await createReview(env, sfToken, { ...ids, model, result }, deps.fetch);
			// A duplicate means an earlier delivery filed the review first. Its verdict is the one that stands.
			verdict =
				outcome.status === "created" ? result.verdict : await findReview(env, sfToken, job.contentVersionId, deps.fetch);
			if (!verdict) throw new SalesforceError("review_unavailable", true);
			await audit(env.AUDIT_DB, { ...ids, stage: "screen", event: "screened", reason: result.failure ?? verdict, attempt, model });
		}

		const flagged = verdict === "tampering_suspected";
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