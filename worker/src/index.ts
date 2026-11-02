import { verifySalesforceRequest } from "./verify";
import { recordNonce, pruneNonces } from "./nonces";
import type { IntakeJob } from "./jobs";
import { handleMessage } from "./consumer";

export type IntakeEnv = Env & {
	SF_SIGNING_KEY: string;
	SF_INSTANCE_URL: string;
	SF_CLIENT_ID: string;
	SF_CLIENT_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REFRESH_TOKEN: string;
};

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname !== "/hooks/salesforce") {
			return new Response(null, { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		}

		const result = await verifySalesforceRequest(request, env.SF_SIGNING_KEY);
		if (!result.ok) {
			// The reason is logged for us; the caller gets a bare 401 and can't tell which check failed.
			console.warn(JSON.stringify({ event: "hook_rejected", reason: result.reason }));
			return new Response(null, { status: 401 });
		}

		const { contentVersionId, checklistItemId, nonce } = result.payload;
		const now = Math.floor(Date.now() / 1000);

		let nonceStatus: "new" | "replay";
		try {
			nonceStatus = await recordNonce(env.AUDIT_DB, nonce, now);
		} catch {
			// Can't check for replay, so don't accept. 503 tells Salesforce to retry later.
			console.error(JSON.stringify({ event: "nonce_store_error" }));
			return new Response(null, { status: 503 });
		}

		if (nonceStatus === "replay") {
			// Verified IDs are safe to log, and useful: a replay means a signed request was captured.
			console.warn(JSON.stringify({ event: "hook_replay", contentVersionId, checklistItemId }));
			return new Response(null, { status: 401 });
		}

		ctx.waitUntil(
			pruneNonces(env.AUDIT_DB, now).catch(() =>
				console.error(JSON.stringify({ event: "nonce_prune_error" })),
			),
		);

				// Salesforce record IDs only, never names or file contents.
		console.log(JSON.stringify({ event: "hook_accepted", contentVersionId, checklistItemId }));

		const job: IntakeJob = { v: 1, contentVersionId, checklistItemId, acceptedAt: now };
		try {
			await env.INTAKE_QUEUE.send(job);
		} catch {
			// The nonce is already spent, so a retry of this exact request will read as a replay.
			// The reconciler picks up checklist items that never got a job.
			console.error(JSON.stringify({ event: "enqueue_error", contentVersionId, checklistItemId }));
			return new Response(null, { status: 503 });
		}

		console.log(JSON.stringify({ event: "job_queued", contentVersionId, checklistItemId }));
		return new Response(null, { status: 202 });
	},
			async queue(batch, env, ctx): Promise<void> {
		for (const message of batch.messages) {
			// Wrapped so fetch is called normally; a detached Workers fetch can throw "Illegal invocation".
			await handleMessage(message, env, { fetch: (input, init) => fetch(input, init) });
		}
			}

} satisfies ExportedHandler<IntakeEnv>;