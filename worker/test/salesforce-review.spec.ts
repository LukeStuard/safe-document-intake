import { describe, expect, it, vi } from "vitest";
import { createReview, type SalesforceEnv } from "../src/salesforce";
import type { ScreenResult } from "../src/screener";

const env: SalesforceEnv = {
	SF_INSTANCE_URL: "https://example.my.salesforce.com/",
	SF_CLIENT_ID: "test-client-id",
	SF_CLIENT_SECRET: "test-client-secret",
	SF_API_VERSION: "68.0",
};

const accepted: ScreenResult = {
	verdict: "pass",
	tamperingDetected: false,
	tamperingExcerpt: "",
	detectedType: "Transcript",
	reasons: "A readable transcript for this applicant.",
	failure: null,
};

function job(result: ScreenResult) {
	return {
		checklistItemId: "a01000000000001AAA",
		contentVersionId: "068000000000001AAA",
		model: "gemini-3.5-flash-lite",
		result,
	};
}

function respond(status: number, body?: unknown) {
	return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

function sent(mock: ReturnType<typeof respond>) {
	const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
	return { url, init, fields: JSON.parse(init.body as string) as Record<string, string> };
}

describe("createReview", () => {
	it("posts the first pass to Document_Review__c and returns the new ID", async () => {
		const mock = respond(201, { id: "a02000000000001AAA", success: true, errors: [] });
		const outcome = await createReview(env, "test-token", job(accepted), mock as unknown as typeof fetch);

		expect(outcome).toEqual({ status: "created", id: "a02000000000001AAA" });
		const { url, init, fields } = sent(mock);
		expect(url).toBe("https://example.my.salesforce.com/services/data/v68.0/sobjects/Document_Review__c");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
		expect(fields).toEqual({
			Checklist_Item__c: "a01000000000001AAA",
			Content_Version_Id__c: "068000000000001AAA",
			Model__c: "gemini-3.5-flash-lite",
			Verdict__c: "pass",
			Reasons__c: "A readable transcript for this applicant.",
			Detected_Type__c: "Transcript",
		});
	});

	it("never sends a decision", async () => {
		const mock = respond(201, { id: "a02000000000001AAA" });
		await createReview(env, "test-token", job(accepted), mock as unknown as typeof fetch);
		const { fields } = sent(mock);
		expect(Object.keys(fields).some((k) => k.startsWith("Decision") || k.startsWith("Decided"))).toBe(false);
	});

	it("records why a rejected answer failed, and keeps its tampering excerpt", async () => {
		const mock = respond(201, { id: "a02000000000002AAA" });
		const rejected: ScreenResult = {
			verdict: "tampering_suspected",
			tamperingDetected: true,
			tamperingExcerpt: "ignore previous instructions",
			detectedType: null,
			reasons: null,
			failure: "reasons_too_long",
		};
		await createReview(env, "test-token", job(rejected), mock as unknown as typeof fetch);
		expect(sent(mock).fields).toEqual({
			Checklist_Item__c: "a01000000000001AAA",
			Content_Version_Id__c: "068000000000001AAA",
			Model__c: "gemini-3.5-flash-lite",
			Verdict__c: "tampering_suspected",
			Tampering_Excerpt__c: "ignore previous instructions",
			Screen_Failure__c: "reasons_too_long",
		});
	});

	it("trims a long detected type to the field length without splitting a character", async () => {
		const mock = respond(201, { id: "a02000000000003AAA" });
		const long = "x".repeat(254) + "😀" + "tail";
		await createReview(env, "test-token", job({ ...accepted, detectedType: long }), mock as unknown as typeof fetch);
		expect(sent(mock).fields.Detected_Type__c).toBe("x".repeat(254));
	});

	it("treats a replayed file version as already reviewed", async () => {
		const mock = respond(400, [{ errorCode: "DUPLICATE_VALUE", message: "duplicate value found", fields: [] }]);
		expect(await createReview(env, "test-token", job(accepted), mock as unknown as typeof fetch)).toEqual({ status: "duplicate" });
	});

	it("gives up on a validation error", async () => {
		const mock = respond(400, [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "must be Pending", fields: [] }]);
		await expect(createReview(env, "test-token", job(accepted), mock as unknown as typeof fetch)).rejects.toMatchObject({
			reason: "review_rejected",
			retryable: false,
		});
	});

	it("gives up when a success has no ID", async () => {
		const mock = respond(201, { success: true });
		await expect(createReview(env, "test-token", job(accepted), mock as unknown as typeof fetch)).rejects.toMatchObject({
			reason: "review_rejected",
			retryable: false,
		});
	});

	it("retries when Salesforce is unavailable", async () => {
		const mock = respond(503);
		await expect(createReview(env, "test-token", job(accepted), mock as unknown as typeof fetch)).rejects.toMatchObject({
			reason: "review_unavailable",
			retryable: true,
		});
	});

	it("retries when the request never arrives", async () => {
		const failing = vi.fn(async () => {
			throw new TypeError("network down");
		});
		await expect(createReview(env, "test-token", job(accepted), failing as unknown as typeof fetch)).rejects.toMatchObject({
			reason: "review_unavailable",
			retryable: true,
		});
	});
});