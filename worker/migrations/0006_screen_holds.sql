-- File versions the pipeline must not screen yet, with why. The held-out eval test set waits here until Phase 4,
-- so no test document reaches the model before the prompt is frozen. Releasing them is one DELETE.
CREATE TABLE screen_holds (
	content_version_id TEXT PRIMARY KEY,
	reason TEXT NOT NULL,
	held_at INTEGER NOT NULL -- seconds since the epoch
);