// Replay protection: every verified request's nonce is recorded once.
// A single INSERT decides new vs. replay, so two copies of a request can't both pass.

// Anything older than this can't return: its timestamp would fail the 5-minute check first.
export const NONCE_RETENTION_SECONDS = 600;

export async function recordNonce(db: D1Database, nonce: string, nowSeconds: number): Promise<"new" | "replay"> {
	const result = await db
		.prepare("INSERT INTO seen_nonces (nonce, received_at) VALUES (?1, ?2) ON CONFLICT(nonce) DO NOTHING")
		.bind(nonce, nowSeconds)
		.run();
	return result.meta.changes === 1 ? "new" : "replay";
}

export async function pruneNonces(db: D1Database, nowSeconds: number): Promise<void> {
	await db
		.prepare("DELETE FROM seen_nonces WHERE received_at < ?1")
		.bind(nowSeconds - NONCE_RETENTION_SECONDS)
		.run();
}