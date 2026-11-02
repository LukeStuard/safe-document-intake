import { parseJob } from "./jobs";
import { getAccessToken, getJobDetails, downloadVersion, SalesforceError, type SalesforceEnv } from "./salesforce";
import { getDriveToken, uploadFile, DriveError, type DriveEnv } from "./drive";
import { folderPath, fileName, LayoutError } from "./layout";
import { findUpload, nextSequence, recordUpload } from "./store";
import { ensureStudentFolder } from "./deliver";

// Must match max_retries (5) in wrangler.jsonc: the first try plus five retries.
export const MAX_ATTEMPTS = 6;

export type ConsumerEnv = SalesforceEnv & DriveEnv & { AUDIT_DB: D1Database };

export interface ConsumerDeps {
	fetch: typeof fetch;
}

// Known failures say whether a retry could help. Naming problems are bad data, so they never retry.
function classify(e: unknown): { reason: string; retryable: boolean } | null {
	if (e instanceof SalesforceError || e instanceof DriveError) return { reason: e.reason, retryable: e.retryable };
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
	const now = () => Math.floor(Date.now() / 1000);

	try {
		// A redelivered job whose file already reached Drive is finished.
		const existing = await findUpload(env.AUDIT_DB, job.contentVersionId);
		if (existing) {
			console.log(JSON.stringify({ event: "job_already_uploaded", ...ids, sequence: existing.sequence }));
			message.ack();
			return;
		}

		const sfToken = await getAccessToken(env, deps.fetch);
		const { item, fileExtension } = await getJobDetails(env, sfToken, job, deps.fetch);
		folderPath(item); // Check the naming data before downloading anything, so bad data fails fast.
		const file = await downloadVersion(env, sfToken, job.contentVersionId, deps.fetch);

		const driveToken = await getDriveToken(env, deps.fetch);
		const folderId = await ensureStudentFolder(env.AUDIT_DB, item, driveToken, deps.fetch, now());
		const sequence = await nextSequence(env.AUDIT_DB, item.applicationId, item.documentType);

		const driveFileId = await uploadFile(
			driveToken,
			{
				name: fileName(item.folderName, item.documentType, sequence, fileExtension),
				parentId: folderId,
				bytes: file.bytes,
				contentType: fileExtension.toLowerCase() === "pdf" ? "application/pdf" : file.contentType,
				appProperties: { contentVersionId: job.contentVersionId, checklistItemId: job.checklistItemId },
			},
			deps.fetch,
		);

		await recordUpload(
			env.AUDIT_DB,
			{
				contentVersionId: job.contentVersionId,
				applicationId: item.applicationId,
				documentType: item.documentType,
				sequence,
				driveFileId,
			},
			now(),
		);

		console.log(
			JSON.stringify({ event: "job_uploaded", ...ids, sequence, bytes: file.bytes.byteLength, attempts: message.attempts }),
		);
		message.ack();
	} catch (e) {
		// Anything unclassified is a bug or a surprise: retry it, and log only the error's type.
		const known = classify(e);
		const reason = known?.reason ?? "unexpected_error";
		const retryable = known?.retryable ?? true;
		const final = !retryable || message.attempts >= MAX_ATTEMPTS;
		console.error(
			JSON.stringify({
				event: "job_failed",
				...ids,
				reason,
				...(known ? {} : { errorName: e instanceof Error ? e.name : typeof e }),
				retryable,
				attempts: message.attempts,
				final,
			}),
		);
		if (retryable) message.retry();
		else message.ack();
	}
}