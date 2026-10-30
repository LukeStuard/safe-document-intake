// Verifies the signed trigger Salesforce sends when a file is attached to a checklist item.
// Order matters: size check, then signature over the raw bytes, and only then JSON parsing.
// Nothing from an unverified body is interpreted or logged.

export const MAX_BODY_BYTES = 4096;
export const MAX_SKEW_SECONDS = 300;

const SF_ID = /^[a-zA-Z0-9]{18}$/;

export interface TriggerPayload {
	v: 1;
	ts: number; // epoch seconds, set by Apex
	nonce: string;
	contentVersionId: string;
	checklistItemId: string;
}

export type VerifyResult =
	| { ok: true; payload: TriggerPayload }
	| { ok: false; reason: string };

export async function verifySalesforceRequest(
	request: Request,
	signingKey: string | undefined,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
	const key = signingKey?.trim();
	if (!key) return { ok: false, reason: "signing_key_missing" };

	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };

	const header = request.headers.get("X-Intake-Signature");
	if (!header) return { ok: false, reason: "signature_missing" };

	let signature: Uint8Array;
	try {
		signature = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
	} catch {
		return { ok: false, reason: "signature_encoding" };
	}
	if (signature.byteLength !== 32) return { ok: false, reason: "signature_length" };

	const body = await request.arrayBuffer();
	if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) {
		return { ok: false, reason: "body_size" };
	}

	// The key is the base64 string's UTF-8 bytes, matching BLOB() in the Named Credential formula.
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	// subtle.verify compares in constant time.
	if (!(await crypto.subtle.verify("HMAC", cryptoKey, signature, body))) {
		return { ok: false, reason: "signature_invalid" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return { ok: false, reason: "body_not_json" };
	}

	const payload = parsed as Partial<TriggerPayload>;
	if (
		payload === null ||
		typeof payload !== "object" ||
		payload.v !== 1 ||
		typeof payload.ts !== "number" ||
		!Number.isInteger(payload.ts) ||
		typeof payload.nonce !== "string" ||
		payload.nonce.length < 16 ||
		payload.nonce.length > 64 ||
		typeof payload.contentVersionId !== "string" ||
		!SF_ID.test(payload.contentVersionId) ||
		!payload.contentVersionId.startsWith("068") ||
		typeof payload.checklistItemId !== "string" ||
		!SF_ID.test(payload.checklistItemId)
	) {
		return { ok: false, reason: "payload_shape" };
	}

	if (Math.abs(nowSeconds - payload.ts) > MAX_SKEW_SECONDS) {
		return { ok: false, reason: "timestamp_stale" };
	}

	return { ok: true, payload: payload as TriggerPayload };
}