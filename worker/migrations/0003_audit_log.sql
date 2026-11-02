-- Append-only audit trail: one row per job event, matching the gateway's audit_log.
-- Record IDs and reason codes only, never names or file contents.
CREATE TABLE audit_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    content_version_id TEXT    NOT NULL,
    checklist_item_id  TEXT    NOT NULL,
    event              TEXT    NOT NULL CHECK (event IN ('queued', 'uploaded', 'already_uploaded', 'failed')),
    reason             TEXT,
    attempt            INTEGER,
    final              INTEGER CHECK (final IN (0, 1)),
    sequence           INTEGER
);

CREATE INDEX idx_audit_ts      ON audit_log (ts);
CREATE INDEX idx_audit_version ON audit_log (content_version_id, ts);

-- Append-only by enforcement, not just by convention: history can't be rewritten, even by a bug in the Worker.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;