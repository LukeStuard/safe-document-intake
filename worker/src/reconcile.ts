import { getAccessToken, listLatestVersions, type SalesforceEnv } from "./salesforce";
import { uploadedVersions } from "./store";
import { auditMany, givenUpVersions } from "./audit";
import { parseJob, type IntakeJob } from "./jobs";

// Also the most messages one sendBatch call accepts. Anything beyond waits for the next run.
export const MAX_PER_RUN = 100;

export type ReconcileEnv = SalesforceEnv & { AUDIT_DB: D1Database; INTAKE_QUEUE: Queue };

export interface ReconcileResult {
	found: number;
	alreadyUploaded: number;
	givenUp: number;
	queued: number;
	deferred: number;
}

// Finds every latest file version on a checklist item that isn't in Drive yet, and queues it as an ordinary job.
// Given-up versions are left for a person: re-queuing bad data every hour would only repeat the failure.
// Duplicates are harmless: the consumer skips anything already uploaded.
export async function reconcile(
	env: ReconcileEnv,
	deps: { fetch: typeof fetch },
	now = Math.floor(Date.now() / 1000),
): Promise<ReconcileResult> {
	const token = await getAccessToken(env, deps.fetch);
	const refs = await listLatestVersions(env, token, deps.fetch);
	const uploaded = await uploadedVersions(env.AUDIT_DB);
	const givenUp = await givenUpVersions(env.AUDIT_DB);

	const seen = new Set<string>();
	const missing: IntakeJob[] = [];
	let alreadyUploaded = 0;
	let skipped = 0;

	for (const ref of refs) {
		if (seen.has(ref.contentVersionId)) continue; // a file linked to two items is still one file
		seen.add(ref.contentVersionId);
		if (uploaded.has(ref.contentVersionId)) {
			alreadyUploaded++;
			continue;
		}
		if (givenUp.has(ref.contentVersionId)) {
			skipped++;
			continue;
		}
		// Same validation as any queue message, so nothing malformed gets queued.
		const job = parseJob({ v: 1, ...ref, acceptedAt: now });
		if (job) missing.push(job);
	}

	const batch = missing.slice(0, MAX_PER_RUN);
	if (batch.length > 0) {
		await env.INTAKE_QUEUE.sendBatch(batch.map((body) => ({ body })));
		// Recorded after sending, so a "queued" row always means the job really was queued.
		await auditMany(
			env.AUDIT_DB,
			batch.map((j) => ({ contentVersionId: j.contentVersionId, checklistItemId: j.checklistItemId, event: "queued" as const, reason: "reconciler" })),
		);
	}

	return { found: seen.size, alreadyUploaded, givenUp: skipped, queued: batch.length, deferred: missing.length - batch.length };
}