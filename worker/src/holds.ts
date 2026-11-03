// Holds: file versions the pipeline must not screen yet (see migration 0006). Filled by hand, released by hand.

export async function isHeld(db: D1Database, contentVersionId: string): Promise<boolean> {
	const row = await db.prepare("SELECT 1 AS held FROM screen_holds WHERE content_version_id = ?").bind(contentVersionId).first();
	return row !== null;
}

export async function heldVersions(db: D1Database): Promise<Set<string>> {
	const { results } = await db.prepare("SELECT content_version_id FROM screen_holds").all<{ content_version_id: string }>();
	return new Set(results.map((r) => r.content_version_id));
}