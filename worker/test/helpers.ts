// Builds signed requests the same way the Salesforce Named Credential will:
// base64 HMAC-SHA256 of the raw body, keyed with the key string's UTF-8 bytes.

export const HOOK_URL = "https://intake.test/hooks/salesforce";

export async function sign(body: string, key: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body)));
	return btoa(String.fromCharCode(...mac));
}

export function payload(ts: number, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		v: 1,
		ts,
		nonce: crypto.randomUUID(),
		contentVersionId: "068000000000001AAA",
		checklistItemId: "a01000000000001AAA",
		...overrides,
	});
}

export function hookRequest(body: string, signature?: string): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (signature !== undefined) headers["X-Intake-Signature"] = signature;
	return new Request(HOOK_URL, { method: "POST", headers, body });
}