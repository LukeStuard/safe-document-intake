// Paces Gemini calls through D1, well under the free tier's limits (15 a minute, 500 a day) on purpose.
// A call is reserved before it is made. A call that then fails still counts, since Google counts it too.

export const MIN_GAP_SECONDS = 8;
export const DAILY_LIMIT = 200;
const DAILY_RETRY_SECONDS = 3600; // check back hourly once the day's budget is spent

export type Reservation = { ok: true } | { ok: false; reason: "too_soon" | "daily_limit"; retryAfterSeconds: number };

const pacificDay = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

// The daily quota resets at midnight Pacific time, so days are counted in Pacific time.
export function quotaDay(now: number): string {
	return pacificDay.format(new Date(now * 1000));
}

export async function reserveCall(db: D1Database, now: number): Promise<Reservation> {
	const day = quotaDay(now);
	// One statement checks both limits and records the call, so two runs can't both slip through.
	const result = await db
		.prepare(
			`INSERT INTO gemini_calls (called_at, day)
			 SELECT ?1, ?2
			 WHERE (SELECT COUNT(*) FROM gemini_calls WHERE day = ?2) < ?3
			   AND NOT EXISTS (SELECT 1 FROM gemini_calls WHERE called_at > ?1 - ?4)`,
		)
		.bind(now, day, DAILY_LIMIT, MIN_GAP_SECONDS)
		.run();
	if (result.meta.changes === 1) return { ok: true };

	// Refused: work out which limit, and how long until a retry could succeed.
	const row = await db
		.prepare(
			"SELECT (SELECT COUNT(*) FROM gemini_calls WHERE day = ?1) AS used, (SELECT MAX(called_at) FROM gemini_calls) AS last",
		)
		.bind(day)
		.first<{ used: number; last: number | null }>();
	if ((row?.used ?? 0) >= DAILY_LIMIT) {
		return { ok: false, reason: "daily_limit", retryAfterSeconds: DAILY_RETRY_SECONDS };
	}
	const wait = Math.ceil((row?.last ?? now) + MIN_GAP_SECONDS - now);
	return { ok: false, reason: "too_soon", retryAfterSeconds: Math.max(1, wait) };
}