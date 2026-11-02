import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleMessage, MAX_ATTEMPTS } from "../src/consumer";
import type { SalesforceEnv } from "../src/salesforce";

const ENV: SalesforceEnv = {
	SF_INSTANCE_URL: "https://example.my.salesforce.com",
	SF_CLIENT_ID: "id",
	SF_CLIENT_SECRET: "secret",
	SF_API_VERSION: "68.0",
};

const JOB = {
	v: 1,
	contentVersionId: "068000000000001AAA",
	checklistItemId: "a01000000000001AAA",
	acceptedAt: 1767225600,
};

// A fake Salesforce: token and download each answer 200 unless told otherwise.
function salesforce(status: { token?: number; download?: number } = {}) {
	const urls: string[] = [];
	const fetchFn = (async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/services/oauth2/token")) {
			return status.token ? new Response("{}", { status: status.token }) : Response.json({ access_token: "tok" });
		}
		return status.download
			? new Response(null, { status: status.download })
			: new Response("%PDF-1.7 test", { headers: { "Content-Type": "application/pdf" } });
	}) as typeof fetch;
	return { fetchFn, urls };
}

async function run(body: unknown, fetchFn: typeof fetch, attempts = 1, env: SalesforceEnv = ENV) {
	const batch = createMessageBatch("intake-documents", [{ id: "msg-1", timestamp: new Date(), attempts, body }]);
	const ctx = createExecutionContext();
	await handleMessage(batch.messages[0], env, { fetch: fetchFn });
	return getQueueResult(batch, ctx);
}

const retried = [expect.objectContaining({ msgId: "msg-1" })];

afterEach(() => vi.restoreAllMocks());

describe("queue consumer", () => {
	it("downloads the job's file and acknowledges it", async () => {
		const { fetchFn, urls } = salesforce();
		const result = await run(JOB, fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(result.retryMessages).toEqual([]);
		expect(urls).toHaveLength(2);
		expect(urls[1]).toContain(`/ContentVersion/${JOB.contentVersionId}/VersionData`);
	});

	it("acknowledges a malformed job without calling Salesforce", async () => {
		const { fetchFn, urls } = salesforce();
		const result = await run({ v: 1, contentVersionId: "not-an-id" }, fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(urls).toHaveLength(0);
	});

	it("retries when Salesforce is temporarily unavailable", async () => {
		const { fetchFn } = salesforce({ download: 503 });
		const result = await run(JOB, fetchFn);

		expect(result.retryMessages).toEqual(retried);
		expect(result.explicitAcks).toEqual([]);
	});

	it("gives up on a file the pipeline can't see, since retrying won't change that", async () => {
		const { fetchFn } = salesforce({ download: 404 });
		const result = await run(JOB, fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(result.retryMessages).toEqual([]);
	});

	it("gives up when the token is refused, without attempting the download", async () => {
		const { fetchFn, urls } = salesforce({ token: 401 });
		const result = await run(JOB, fetchFn);

		expect(result.explicitAcks).toEqual(["msg-1"]);
		expect(urls).toHaveLength(1);
	});

	it("retries an unexpected error, logging only its type", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { fetchFn } = salesforce();
		const broken = { ...ENV, SF_INSTANCE_URL: undefined } as unknown as SalesforceEnv;

		const result = await run(JOB, fetchFn, 1, broken);

		expect(result.retryMessages).toEqual(retried);
		const logged = JSON.parse(String(errors.mock.calls[0][0]));
		expect(logged.reason).toBe("unexpected_error");
		expect(logged.errorName).toBe("TypeError");
		expect(Object.keys(logged)).not.toContain("message");
	});

	it("marks the last attempt as final", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { fetchFn } = salesforce({ download: 503 });

		await run(JOB, fetchFn, MAX_ATTEMPTS - 1);
		await run(JOB, fetchFn, MAX_ATTEMPTS);

		expect(JSON.parse(String(errors.mock.calls[0][0])).final).toBe(false);
		expect(JSON.parse(String(errors.mock.calls[1][0])).final).toBe(true);
	});
});