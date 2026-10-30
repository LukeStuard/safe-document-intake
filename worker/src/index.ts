import { verifySalesforceRequest } from "./verify";

type IntakeEnv = Env & { SF_SIGNING_KEY: string };

export default {
	async fetch(request, env): Promise<Response> {
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

		// Salesforce record IDs only, never names or file contents.
		console.log(
			JSON.stringify({
				event: "hook_accepted",
				contentVersionId: result.payload.contentVersionId,
				checklistItemId: result.payload.checklistItemId,
			}),
		);

		// Replay protection (nonce in D1) and queueing come next. Until then, accepted means verified only.
		return new Response(null, { status: 202 });
	},
} satisfies ExportedHandler<IntakeEnv>;