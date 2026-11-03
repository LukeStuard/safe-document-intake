-- One row per Gemini call the pipeline reserved, so pacing holds across invocations, retries and restarts.
CREATE TABLE gemini_calls (
	id INTEGER PRIMARY KEY,
	called_at INTEGER NOT NULL, -- seconds since the epoch
	day TEXT NOT NULL           -- YYYY-MM-DD in Pacific time, when the free tier's daily quota resets
);
CREATE INDEX gemini_calls_day ON gemini_calls (day);
CREATE INDEX gemini_calls_called_at ON gemini_calls (called_at);