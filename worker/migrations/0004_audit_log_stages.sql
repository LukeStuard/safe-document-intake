-- Rebuilds audit_log to add the screening stage. SQLite can't change a CHECK constraint in place,
-- so the table is recreated and every existing row copied unchanged. The append-only triggers are
-- dropped for the rebuild and recreated at the end. They protect history from the Worker and from
-- ordinary queries; a schema migration like this one is the deliberate exception, and is logged as such.

DROP TRIGGER audit_log_no_update;
DROP TRIGGER audit_log_no_delete;

ALTER TABLE audit_log RENAME TO audit_log_v1;

CREATE TABLE audit_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    content_version_id TEXT    NOT NULL,
    checklist_item_id  TEXT    NOT NULL,
    stage              TEXT    NOT NULL DEFAULT 'intake' CHECK (stage IN ('intake', 'screen')),
    event              TEXT    NOT NULL CHECK (event IN (
                           'queued', 'uploaded', 'already_uploaded', 'failed',
                           'screened', 'already_screened', 'deferred')),
    reason             TEXT,
    attempt            INTEGER,
    final              INTEGER CHECK (final IN (0, 1)),
    sequence           INTEGER,
    model              TEXT
);

-- Every row from before the screening stage was an intake event.
INSERT INTO audit_log (id, ts, content_version_id, checklist_item_id, stage, event, reason, attempt, final, sequence, model)
SELECT id, ts, content_version_id, checklist_item_id, 'intake', event, reason, attempt, final, sequence, NULL
FROM audit_log_v1;

DROP TABLE audit_log_v1;

CREATE INDEX idx_audit_ts      ON audit_log (ts);
CREATE INDEX idx_audit_version ON audit_log (content_version_id, ts);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;