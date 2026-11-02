-- Drive side of the pipeline. Record IDs and Drive IDs only: no names, no file contents.

-- Every folder the Worker created, keyed by what the folder is, never by its display name:
-- 'root', 'stage', 'year:2026', 'term:Fall 2026', 'application:<Salesforce ID>'.
-- Finding folders by key means duplicate or corrected names can't misfile a document.
CREATE TABLE drive_folders (
    folder_key TEXT    PRIMARY KEY,
    folder_id  TEXT    NOT NULL,
    created_at INTEGER NOT NULL  -- epoch seconds
);

-- One row per uploaded file. The ContentVersion key makes redelivered jobs safe to skip,
-- and the unique sequence index keeps "#n" numbering from ever repeating within a document type.
CREATE TABLE drive_uploads (
    content_version_id TEXT    PRIMARY KEY,
    application_id     TEXT    NOT NULL,
    document_type      TEXT    NOT NULL,
    sequence           INTEGER NOT NULL,
    drive_file_id      TEXT    NOT NULL,
    uploaded_at        INTEGER NOT NULL  -- epoch seconds
);

CREATE UNIQUE INDEX idx_uploads_sequence ON drive_uploads (application_id, document_type, sequence);