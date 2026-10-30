import { describe, it, expect } from "vitest";
import { verifySalesforceRequest, MAX_BODY_BYTES, MAX_SKEW_SECONDS } from "../src/verify";
import { sign, payload, hookRequest } from "./helpers";

const KEY = "unit-test-key-not-real";
const NOW = 1_800_000_000;

async function check(body: string, opts: { key?: string; signWith?: string; signature?: string; now?: number } = {}) {
	const signature = opts.signature ?? (await sign(body, opts.signWith ?? KEY));
	return verifySalesforceRequest(hookRequest(body, signature), opts.key ?? KEY, opts.now ?? NOW);
}

describe("verifySalesforceRequest", () => {
	it("accepts a correctly signed, current, well-formed request", async () => {
		const result = await check(payload(NOW));
		expect(result.ok).toBe(true);
	});

	it("trims a trailing newline from the stored key", async () => {
		const result = await check(payload(NOW), { key: `${KEY}\r\n` });
		expect(result.ok).toBe(true);
	});

	it("fails closed when the signing key is missing", async () => {
		expect(await check(payload(NOW), { key: "" })).toEqual({ ok: false, reason: "signing_key_missing" });
		expect(await check(payload(NOW), { key: "   " })).toEqual({ ok: false, reason: "signing_key_missing" });
	});

	it("rejects a request with no signature", async () => {
		const result = await verifySalesforceRequest(hookRequest(payload(NOW)), KEY, NOW);
		expect(result).toEqual({ ok: false, reason: "signature_missing" });
	});

	it("rejects a signature that isn't base64", async () => {
		expect(await check(payload(NOW), { signature: "not base64!!" })).toEqual({ ok: false, reason: "signature_encoding" });
	});

	it("rejects a signature of the wrong length", async () => {
		expect(await check(payload(NOW), { signature: btoa("short") })).toEqual({ ok: false, reason: "signature_length" });
	});

	it("rejects a signature made with a different key", async () => {
		expect(await check(payload(NOW), { signWith: "attacker-key" })).toEqual({ ok: false, reason: "signature_invalid" });
	});

	it("rejects a body changed after signing", async () => {
		const original = payload(NOW);
		const signature = await sign(original, KEY);
		const tampered = original.replace("068000000000001AAA", "068000000000002AAA");
		const result = await verifySalesforceRequest(hookRequest(tampered, signature), KEY, NOW);
		expect(result).toEqual({ ok: false, reason: "signature_invalid" });
	});

	it("rejects an empty body", async () => {
		expect(await check("")).toEqual({ ok: false, reason: "body_size" });
	});

	it("rejects an oversized body even when signed", async () => {
		const big = payload(NOW, { padding: "x".repeat(MAX_BODY_BYTES) });
		expect(await check(big)).toEqual({ ok: false, reason: "body_size" });
	});

	it("rejects a signed body that isn't JSON", async () => {
		expect(await check("hello")).toEqual({ ok: false, reason: "body_not_json" });
	});

	it.each([
		["wrong version", { v: 2 }],
		["string timestamp", { ts: String(NOW) }],
		["fractional timestamp", { ts: NOW + 0.5 }],
		["short nonce", { nonce: "abc" }],
		["15-character ID", { contentVersionId: "068000000000001" }],
		["non-ContentVersion prefix", { contentVersionId: "069000000000001AAA" }],
		["missing checklist item", { checklistItemId: undefined }],
	])("rejects a signed payload with %s", async (_label, overrides) => {
		expect(await check(payload(NOW, overrides))).toEqual({ ok: false, reason: "payload_shape" });
	});

	it("accepts timestamps at the edge of the window", async () => {
		expect((await check(payload(NOW - MAX_SKEW_SECONDS))).ok).toBe(true);
		expect((await check(payload(NOW + MAX_SKEW_SECONDS))).ok).toBe(true);
	});

	it("rejects timestamps outside the window, past or future", async () => {
		expect(await check(payload(NOW - MAX_SKEW_SECONDS - 1))).toEqual({ ok: false, reason: "timestamp_stale" });
		expect(await check(payload(NOW + MAX_SKEW_SECONDS + 1))).toEqual({ ok: false, reason: "timestamp_stale" });
	});
});