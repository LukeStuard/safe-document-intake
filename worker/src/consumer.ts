import { parseJob } from "./jobs";
import { getAccessToken, downloadVersion, SalesforceError, type SalesforceEnv } from "./salesforce";

// Must match max_retries (5) in wrangler.jsonc: the first try plus five retries.
export const MAX_ATTEMPTS = 6;

export interface ConsumerDeps {
	fetch: typeof fetch;
}

export async function handleMessage(message: Message<unknown>, env: SalesforceEnv, deps: ConsumerDeps): Promise<void> {
	const job = parseJob(message.body);
	if (!job) {
		// Only our own webhook writes to this queue, so a bad message means a bug, and retrying won't fix it.
		// Log the queue's message ID, never the body.
		console.error(JSON.stringify({ event: "job_malformed", messageId: message.id }));
		message.ack();
		return;
	}

	const ids = { contentVersionId: job.contentVersionId, checklistItemId: job.checklistItemId };

	try {
		const token = await getAccessToken(env, deps.fetch);
		const file = await downloadVersion(env, token, job.contentVersionId, deps.fetch);

		// Drive upload comes next. Until then, a successful download completes the job.
		console.log(
			JSON.stringify({ event: "job_downloaded", ...ids, bytes: file.bytes.byteLength, attempts: message.attempts }),
		);
		message.ack();
	} catch (e) {
		// Anything that isn't a known Salesforce failure is a bug or a surprise: retry it, and log only the error's type.
		const known = e instanceof SalesforceError;
		const reason = known ? e.reason : "unexpected_error";
		const retryable = known ? e.retryable : true;
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