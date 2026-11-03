import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DAILY_LIMIT, MIN_GAP_SECONDS, quotaDay, reserveCall } from "../src/pacing";

const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;
const NOW = Date.UTC(2026, 10, 3, 20, 0, 0) / 1000; // noon Pacific, well clear of a day boundary

async function callCount(): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM gemini_calls").first<{ n: number }>();
	return row?.n ?? 0;
}

async function seedCalls(day: string, count: number, calledAt: number) {
	await db.batch(
		Array.from({ length: count }, () =>
			db.prepare("INSERT INTO gemini_calls (called_at, day) VALUES (?1, ?2)").bind(calledAt, day),
		),
	);
}

beforeEach(async () => {
	await db.prepare("DELETE FROM gemini_calls").run();
});

describe("quotaDay", () => {
	it("counts days in Pacific Standard Time in winter", () => {
		expect(quotaDay(Date.UTC(2026, 10, 4, 7, 59, 59) / 1000)).toBe("2026-11-03");
		expect(quotaDay(Date.UTC(2026, 10, 4, 8, 0, 0) / 1000)).toBe("2026-11-04");
	});

	it("counts days in Pacific Daylight Time in summer", () => {
		expect(quotaDay(Date.UTC(2026, 6, 1, 6, 59, 59) / 1000)).toBe("2026-06-30");
		expect(quotaDay(Date.UTC(2026, 6, 1, 7, 0, 0) / 1000)).toBe("2026-07-01");
	});
});

describe("reserveCall", () => {
	it("reserves the first call and records it", async () => {
		expect(await reserveCall(db, NOW)).toEqual({ ok: true });
		expect(await callCount()).toBe(1);
	});

	it("refuses a call inside the gap, says how long to wait, and records nothing", async () => {
		await reserveCall(db, NOW);
		expect(await reserveCall(db, NOW + 3)).toEqual({ ok: false, reason: "too_soon", retryAfterSeconds: MIN_GAP_SECONDS - 3 });
		expect(await callCount()).toBe(1);
	});

	it("allows the next call once the full gap has passed", async () => {
		await reserveCall(db, NOW);
		expect(await reserveCall(db, NOW + MIN_GAP_SECONDS)).toEqual({ ok: true });
		expect(await callCount()).toBe(2);
	});

	it("refuses once the day's budget is spent", async () => {
		await seedCalls(quotaDay(NOW), DAILY_LIMIT, NOW - 3600);
		expect(await reserveCall(db, NOW)).toEqual({ ok: false, reason: "daily_limit", retryAfterSeconds: 3600 });
		expect(await callCount()).toBe(DAILY_LIMIT);
	});

	it("doesn't count yesterday's calls against today", async () => {
		await seedCalls("2026-11-02", DAILY_LIMIT, NOW - 86_400);
		expect(await reserveCall(db, NOW)).toEqual({ ok: true });
	});

	it("starts a fresh budget at midnight Pacific", async () => {
		const lastMinute = Date.UTC(2026, 10, 4, 7, 59, 0) / 1000;
		await seedCalls(quotaDay(lastMinute), DAILY_LIMIT, lastMinute - 3600);
		expect((await reserveCall(db, lastMinute)).ok).toBe(false);
		expect(await reserveCall(db, lastMinute + 60)).toEqual({ ok: true });
	});
});