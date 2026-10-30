import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { recordNonce, pruneNonces, NONCE_RETENTION_SECONDS } from "../src/nonces";

const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;
const NOW = 1_800_000_000;

async function count(nonce: string): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM seen_nonces WHERE nonce = ?1").bind(nonce).first<{ n: number }>();
	return row?.n ?? 0;
}

describe("nonce store", () => {
	it("records a new nonce, then reports the same nonce as a replay", async () => {
		const nonce = crypto.randomUUID();
		expect(await recordNonce(db, nonce, NOW)).toBe("new");
		expect(await recordNonce(db, nonce, NOW)).toBe("replay");
		expect(await count(nonce)).toBe(1);
	});

	it("treats different nonces independently", async () => {
		expect(await recordNonce(db, crypto.randomUUID(), NOW)).toBe("new");
		expect(await recordNonce(db, crypto.randomUUID(), NOW)).toBe("new");
	});

	it("prunes nonces past retention and keeps recent ones", async () => {
		const old = crypto.randomUUID();
		const edge = crypto.randomUUID();
		const recent = crypto.randomUUID();
		await recordNonce(db, old, NOW - NONCE_RETENTION_SECONDS - 1);
		await recordNonce(db, edge, NOW - NONCE_RETENTION_SECONDS);
		await recordNonce(db, recent, NOW - 10);

		await pruneNonces(db, NOW);

		expect(await count(old)).toBe(0);
		expect(await count(edge)).toBe(1);
		expect(await count(recent)).toBe(1);
	});
});