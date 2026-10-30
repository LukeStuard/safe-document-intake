-- Replay protection for the signed Salesforce trigger: one row per verified request.
-- Only requests that passed signature, shape and timestamp checks are recorded,
-- so unsigned traffic can't fill this table. Stores the nonce and arrival time only.
CREATE TABLE seen_nonces (
    nonce       TEXT    PRIMARY KEY,
    received_at INTEGER NOT NULL  -- epoch seconds
);

CREATE INDEX idx_nonces_received ON seen_nonces (received_at);