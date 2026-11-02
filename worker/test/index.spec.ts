import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { sign, payload, hookRequest, HOOK_URL } from "./helpers";
import type { IntakeEnv } from "../src/index";

const testEnv = env as unknown as { SF_SIGNING_KEY: string; AUDIT_DB: D1Database };
const KEY = testEnv.SF_SIGNING_KEY;
const now = () => Math.floor(Date.now() / 1000);

async function nonceRows(): Promise<number> {
	const row = await testEnv.AUDIT_DB.prepare("SELECT COUNT(*) AS n FROM seen_nonces").first<{ n: number }>();
	return row?.n ?? 0;
}

describe("intake Worker routing", () => {
	it("returns 404 for anything but the hook path", async () => {
		const response = await exports.default.fetch("https://intake.test/");
		expect(response.status).toBe(404);
	});

	it("returns 405 for non-POST requests to the hook", async () => {
		const response = await exports.default.fetch(HOOK_URL);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it("returns a bare 401 for an unsigned request, and records nothing", async () => {
		const before = await nonceRows();
		const response = await exports.default.fetch(hookRequest(payload(now())));
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("");
		expect(await nonceRows()).toBe(before);
	});

	it("returns the same bare 401 for a bad signature, so callers can't tell which check failed", async () => {
		const body = payload(now());
		const response = await exports.default.fetch(hookRequest(body, await sign(body, "wrong-key")));
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("");
	});

	it("returns 202 for a valid signed request", async () => {
		const body = payload(now());
		const response = await exports.default.fetch(hookRequest(body, await sign(body, KEY)));
		expect(response.status).toBe(202);
	});
});

describe("replay protection", () => {
	it("accepts a signed request once and rejects an exact replay", async () => {
		const body = payload(now());
		const signature = await sign(body, KEY);

		const first = await exports.default.fetch(hookRequest(body, signature));
		expect(first.status).toBe(202);

		const replay = await exports.default.fetch(hookRequest(body, signature));
		expect(replay.status).toBe(401);
		expect(await replay.text()).toBe("");
	});

	it("fails closed with 503 when the nonce store is unavailable", async () => {
		const brokenDb = {
			prepare() {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;
		const body = payload(now());
		const ctx = createExecutionContext();

		const response = await worker.fetch(
			hookRequest(body, await sign(body, KEY)) as Request<unknown, IncomingRequestCfProperties>,
			{ ...testEnv, AUDIT_DB: brokenDb } as unknown as IntakeEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
	});
});
// A stand-in for the queue binding that records what the Worker sends.
function captureQueue(fail = false) {
	const sent: unknown[] = [];
	const queue = {
		async send(body: unknown) {
			if (fail) throw new Error("Queue unavailable");
			sent.push(body);
		},
		async sendBatch() {
			throw new Error("sendBatch is not used by the webhook");
		},
	} as unknown as Queue;
	return { queue, sent };
}

async function runWorker(body: string, signature: string, overrides: Record<string, unknown>) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		hookRequest(body, signature) as Request<unknown, IncomingRequestCfProperties>,
		{ ...testEnv, ...overrides } as unknown as IntakeEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("queueing", () => {
	it("queues exactly one job carrying record IDs only", async () => {
		const { queue, sent } = captureQueue();
		const body = payload(now());

		const response = await runWorker(body, await sign(body, KEY), { INTAKE_QUEUE: queue });

		expect(response.status).toBe(202);
		expect(sent).toHaveLength(1);
		const job = sent[0] as Record<string, unknown>;
		// Pin the exact field list, so nothing about the applicant can slip into a message unnoticed.
		expect(Object.keys(job).sort()).toEqual(["acceptedAt", "checklistItemId", "contentVersionId", "v"]);
		expect(job.v).toBe(1);
		expect(Math.abs((job.acceptedAt as number) - now())).toBeLessThan(5);
	});

	it("does not queue a second job for a replayed request", async () => {
		const { queue, sent } = captureQueue();
		const body = payload(now());
		const signature = await sign(body, KEY);

		expect((await runWorker(body, signature, { INTAKE_QUEUE: queue })).status).toBe(202);
		expect((await runWorker(body, signature, { INTAKE_QUEUE: queue })).status).toBe(401);
		expect(sent).toHaveLength(1);
	});

	it("returns 503 when the queue is unavailable, with the nonce already spent", async () => {
		const { queue } = captureQueue(true);
		const body = payload(now());
		const signature = await sign(body, KEY);
		const before = await nonceRows();

		const response = await runWorker(body, signature, { INTAKE_QUEUE: queue });

		expect(response.status).toBe(503);
		// Documents the chosen trade-off: a failed enqueue still uses up the nonce,
		// and the reconciler, not a retry of this request, recovers the job.
		expect(await nonceRows()).toBe(before + 1);
	});
	
});

