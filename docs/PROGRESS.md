# Progress Log

## Phase 0: Repo and Google setup (2026-10-28)

- Repo: safe-document-intake (SFDX project), default org gatewayDev (shared with safe-agent-gateway;
  each repo deploys only the metadata it owns)
- Secret scanning: gitleaks 8.30.1 as a Husky pre-commit hook, ahead of lint-staged
  - Fake GitHub token staged: commit blocked, 2 findings, secret redacted in output: PASS
- .gitattributes pins LF line endings; PDFs and PNGs marked binary for the eval set
- Google Cloud project on a personal account, no billing account, no free trial
- Drive API enabled; OAuth consent screen External, published "In production"
  - Publishing required a homepage and privacy policy URL: repo page and PRIVACY.md
  - No logo uploaded (a logo triggers brand verification)
  - drive.file listed under non-sensitive scopes, so no verification review needed
  - Production mode avoids Testing mode's 7-day refresh token expiry
- OAuth client: Desktop app type, credentials in Credential Manager (SafeDocumentIntake-Google)
- scripts/Get-GoogleRefreshToken.ps1: PKCE S256, random state, loopback on 127.0.0.1:33419 via raw
  TCP listener; refuses to store anything unless the grant is exactly drive.file; refresh token
  written to Credential Manager (SafeDocumentIntake-GoogleRefresh), never printed or saved to disk
  - Sign-in, state check, code exchange, scope check: PASS
  - Refresh token to access token with no browser: PASS
  - Test upload (phase0-test.txt): PASS
  - Least privilege: file list returns only the app-created file while the Drive holds others: PASS

## Remaining in Phase 0

- Hello-world Worker deployed to the personal Cloudflare account
- Confirm current Workers AI and Gemini free-tier limits and PDF/image support
- Confirm a Developer Edition flow can make the signed callout, or plan an Apex helper

## Phase 0: Gemini model selection (2026-10-29)

- Gemini API key on the personal Google account, project safe-document-intake, free tier, no billing
  - A first key was accidentally created under a university Google account (AI Studio defaulted to the
    browser's first signed-in account); it was deleted, along with a second key auto-created in a
    "Default Gemini Project". One live key remains, attached to safe-document-intake
  - Key stored in Credential Manager (SafeDocumentIntake-Gemini) via the Get-Credential dialog;
    clipboard cleared after storing; sent as an x-goog-api-key header, never in a URL
  - New key format (AQ. prefix, 53 chars): confirm gitleaks detects it before committing Gemini code
- Free-tier limits from AI Studio: Flash models 5 RPM / 20 RPD; Flash-Lite 15 RPM / 500 RPD
- Decision: gemini-3.5-flash-lite as the primary reviewer, pinned by version (not the "latest" alias,
  so eval results stay reproducible); gemini-3.8-flash as a spot check on the hardest documents
- Design consequence: the queue consumer must pace calls to stay under 15 requests per minute
- PDF test, text PDF: correct name, institution, GPA: PASS
- PDF test, image-only scan (no text layer, noise, slight rotation): correct name, institution, GPA: PASS
  - Both used 545 prompt tokens, so scans cost the same as text PDFs
  - Free-text fields drifted between the two copies ("unofficial academic transcript" vs
    "transcript"), supporting fixed-verdict output over free-text descriptions

## 2026-10-29: Worker scaffold and first deploy

- Scaffolded `worker/` with C3 (hello-world, TypeScript, no nested git), AGENTS.md included to match the gateway.
- Wrangler 4.156.0. Vitest and the Cloudflare Vitest plugin kept, for the safety tests.
- Renamed to `safe-document-intake`; deployed to the gateway's Cloudflare account and confirmed the hello-world response.
- Confirmed `node_modules/` and `.dev.vars*` are ignored.
- No MCP in this Worker: the pipeline has no agent-facing surface. Claude reaches review data only through the gateway's MCP server.
- Phase 0 complete.

## 2026-10-29: Separate Cloudflare token and Workers AI access

- Created a dedicated `safe-document-intake` API token instead of widening the gateway's token. Permissions: Workers Scripts Edit, Workers AI Read, Account Settings Read, User Details Read, Memberships Read. Queues and D1 will be added in Phase 2 when needed.
- Helper renamed to `scripts/Use-IntakeCloudflare.ps1`, reading the `SafeDocumentIntake-CF` credential.
- Incident: the credential storage command printed the new token to the terminal. Token rolled within minutes; storage command now pipes to `Out-Null`.
- Workers AI: `@cf/qwen/qwen3.8-27b` works on the free plan with Workers AI Read only. Test call: 58 input + 35 output tokens = 12.55 neurons, consistent with listed per-token pricing. Reasoning output dominates cost; rough estimate is ~55 single-page documents per day on the free allocation.

## 2026-10-29: Phase 1 data model and enforced review rules

- Deployed `Checklist_Item__c` (master-detail to `Application__c`) and `Document_Review__c`, following the gateway's `Review_Note_Request__c` patterns.
- Six validation rules: New_Review_Must_Be_Pending, Decision_Is_Final (decision and note), Pipeline_Cannot_Decide, Verdict_Is_Immutable (applies to admins), Decision_Stamp_Is_System, Rejection_Needs_Note. Stamp flow records Decided_By/Decided_On before save.
- Permission sets: Intake_Integration (create reviews, read applicant name only), Intake_Reviewer (decision and note only), Intake_Admin (full field access, no deleting reviews).
- Correct eval verdicts will live in `eval/manifest.json`, not Salesforce, so the pipeline user can never read the answer key.
- `DocumentReviewRulesTest`: 10/10 passing.
- Finding: this org enforces field permissions on Apex DML. New fields were invisible to the admin until Intake_Admin existed. Tests grant the admin full access so validation rules are proven independently of permissions.
- Finding: the pipeline user could not see checklist items (sharing inherited from private `Application__c`). Fixed with View All on `Application__c`; field permissions still limit it to the applicant lookup. The tests caught this before any pipeline code existed.
- Finding: the pipeline is blocked from deciding by three independent layers: no object edit access, no decision field access, and Pipeline_Cannot_Decide. Each is proven by its own test.

- Least privilege on applicant data: added `Application__c.Applicant_Name__c` (formula from the related Contact). Intake_Integration now has explicit `allowRead=false` on Contact and no access to the `Applicant__c` lookup, matching the gateway's rule that integration users never touch Contact.
- Finding: permission sets only add access. A Standard User profile silently granted Contact read despite Intake_Integration denying it. The test caught it; the pipeline user (in tests and in the org) runs on Minimum Access - Salesforce, so every permission comes from the permission set.
- Licenses: the org's one Salesforce Integration license belongs to the gateway, so the pipeline user takes a Salesforce license with the Minimum Access profile. Platform licenses were rejected because their standard profile grants Contact read.
- Sharing differs from the gateway on purpose: View All on `Application__c` instead of a sharing rule that hides Drafts, since a Draft application can still receive documents.
- Practice: verify permissions by querying the org, not by reading the file. Two edits this project (and one in the gateway) never reached the org.
- `DocumentReviewRulesTest`: 11/11 passing.

## 2026-10-29: Pipeline integration user and client credentials

- User `intake.pipeline@safe-document-intake.dev`: Salesforce license, Minimum Access - Salesforce profile, Intake_Integration only (now with API Enabled, verified by query).
- External Client App "Safe Document Intake Pipeline", separate from the gateway's apps (one app per trust boundary): client credentials only, scope `api` only, Run As the pipeline user. Consumer key and secret in Credential Manager (`SafeDocumentIntake-SF`).
- Live checks as the pipeline user, through a real client-credentials token:
  - Token scope `api` only: PASS
  - `Applicant_Name__c` readable through the formula: PASS
  - Contact query returns `INVALID_TYPE`: PASS
  - Document_Review__c describe: createable True, updateable False, deletable False: PASS
- Tightened Permitted Users to admin-approved with only Intake_Integration approved; token still issues: PASS

## 2026-10-29: Eval set generated and loaded

- `eval/generate.py` (seed 20261029): 20 applications sampled from the org's 210 non-Draft records, 100 checklist items, 60 documents: 20 good (about 30% as image-only scans), 8 wrong type, 8 name mismatch (using another real applicant's name), 8 illegible (blank, faded and noisy, low resolution), 16 injection fixtures across five styles (visible, white text, 1-point text, PDF metadata, fake registrar's note).
- Output is byte-for-byte reproducible. Pinned reportlab invariant mode and Pillow 13's PDF timestamps.
- `eval/manifest.json` is the answer key, kept in the repo and never in Salesforce. Each injection records whether it is visible in the rendered image, the text layer, or neither.
- File names and PDF metadata are neutral (`doc-NNNN.pdf`, title "Document") so the category can't be inferred from them.
- Reviewed the synthetic documents before loading and fixed three problems that would have scored correct model judgments as errors: transcript course dates outside the degree years, a GPA unrelated to the grades shown, and the watermark drawn over injected text. The faded-scan style was also still readable on first pass and was made truly illegible.
- `eval/load.py` creates checklist items in one all-or-nothing request and attaches files as the admin. It refuses to load twice.
- Finding: the sf CLI now redacts access tokens in `org display --json`. The loader was rewritten to make every call through `sf api request rest`, so it never handles a token.
- Verified in the org: 60 Received, 40 Not Received, 60 files attached.
- Phase 1 complete.

## 2026-10-30: Signed trigger, Worker side

- Signing secret: 32 random bytes, generated straight into Credential Manager (`SafeDocumentIntake-Signing`) and piped into the Worker secret `SF_SIGNING_KEY`. Never displayed or written to a file. `GatewayCredential.ps1` gained `Set-GatewayCredential` (Win32 `CredWrite`) to make that possible.
- Salesforce side will sign with a Named Credential custom header formula: `HMAC('SHA-256', $Credential.<ext>.Body, BLOB(key))`. Apex never sees the secret, and principal parameter values aren't deployable metadata, so it never reaches git.
- `POST /hooks/salesforce` verifies before parsing: size limit (4 KB), signature over the raw bytes with `crypto.subtle.verify` (constant-time), then payload shape (18-character IDs, `068` prefix on the ContentVersion), then a 5-minute timestamp window, past or future.
- Every rejection returns the same bare 401. The reason is logged; nothing from an unverified body is.
- Key is trimmed before use, in case the PowerShell pipe added a newline. Tested.
- Finding: the `create-cloudflare` scaffold's sample test used the retired `SELF` binding. Current `@cloudflare/vitest-plugin` uses `exports.default.fetch()` from `cloudflare:workers`. Replaced.
- 25 tests passing (20 unit, 5 integration). Tests use a fake key from the Vitest config.
- Next: nonce replay protection in D1.

## 2026-10-30: Replay protection

- Added D1: Edit to the intake Cloudflare token (one permission, logged here). Token still has no expiry or IP filter; noted for the hardening list.
- Finding: D1 token permissions are account-wide, so the intake token can also reach `gateway-audit`. The intake Worker can't, since a Worker only reaches databases bound to it. Separate Cloudflare accounts would be the real fix; noted for the hardening list.
- New database `intake-audit`, bound as `AUDIT_DB` to match the gateway. Migration `0001_init_nonces.sql` creates `seen_nonces`.
- Each verified request's nonce is recorded with one atomic `INSERT ... ON CONFLICT DO NOTHING`, so there's no gap where two copies of a request both pass. A repeat gets the same bare 401.
- Only verified requests are recorded, so unsigned traffic can't fill the table. Nonces older than 10 minutes are pruned after each accepted request.
- If D1 is unavailable, the Worker fails closed with 503 rather than accepting a request it can't check for replay.
- Tests run against a local D1 with the same migration applied. 30 passing.

## 2026-10-30: Signed trigger, end to end

- Salesforce side: `ContentDocumentLink` trigger (file attached) and `ContentVersion` trigger (new version), both feeding `IntakeTriggerSender`, a Queueable that sends IDs only, in batches of 20 at a 5-second timeout. Best-effort; failures logged with record IDs. A scheduled reconciler (later) will cover failed sends and backfill. 9 Apex tests; 100% on the handler and triggers.
- Finding: the documented `$Credential.<name>.Body` formula field doesn't resolve in this org ("Field Intake_Signing.Body does not exist"), whether the header is set on the External Credential or from Apex, with body formulas on or off. Proven with debug logs, not assumed.
- Proved the rest of the formula independently with anonymous Apex probes: `SigningKey` resolves and `HMAC` evaluates (`signature_invalid` on a mismatched body), then a matched probe passed the Worker's signature check, proving Salesforce's HMAC matches the Worker's byte for byte.
- Fix: the body is now plain text, `v|ts|nonce|contentVersionId|checklistItemId`, and Apex puts that exact string into the formula as a literal. The signature still covers the raw body and the Worker still verifies before parsing, so no rule changed. The key never reaches Apex.
- Guard: Apex refuses to build a formula from any payload containing characters other than letters, digits, hyphens and pipes, so a value can never break out of the formula literal. Tested with quotes, braces and `{!`.
- Worker: rejects any payload that isn't exactly five well-formed fields, including the old JSON format. Decodes strictly as UTF-8 and keeps a byte-order mark so it fails the check. 33 Worker tests.
- Near miss: a terminal without the intake token loaded fell back to a stale Wrangler OAuth login for CIAM's Cloudflare account. The deploy failed only because the D1 binding pointed at a database in the personal account. Confirmed nothing was created there. Fix: `account_id` pinned in `wrangler.jsonc`, so deploys from any other login are refused.
- Checklist Item layout: Files and Document Reviews related lists added. Notes & Attachments deliberately left off, since legacy attachments would bypass the Files triggers.
- Live result: a new file version uploaded in the UI produced `hook_accepted` at the Worker, with its nonce recorded in D1.

## 2026-11-02: Queue and consumer skeleton

- Added Queues: Edit to the intake Cloudflare token (one permission, logged here).
- Queues are on the Workers free plan, but retention is capped at 24 hours, and that applies to the dead-letter queue too. So the DLQ can't be the record of a failure: the consumer must write failures to the D1 audit log before giving up, and the reconciler re-finds unfinished work.
- Created `intake-documents` and `intake-documents-dlq`. Declined Wrangler's offer to append a binding, so the whole queue config was written and reviewed in one edit.
- Consumer settings: batch size 1 (one bad PDF can't fail its neighbors, and each run stays well under the free plan's 50 subrequests), concurrency 1 (pacing for Gemini later), 5 retries 60 seconds apart, then the DLQ. `retry_delay` confirmed in the installed Wrangler's schema before use.
- The webhook enqueues a versioned job carrying record IDs only. A test pins the exact field list.
- Ordering decision: the nonce is recorded before enqueueing. If the enqueue fails, the Worker returns 503 and the nonce stays spent, so the reconciler recovers the job rather than a retry. The reverse order would let a replayed request create duplicate jobs. A test documents this trade-off.
- The consumer validates every message (`parseJob`) and rebuilds it, dropping unknown fields. Malformed messages are logged by queue message ID and acknowledged, since only our own webhook writes to the queue and a retry can't fix a bug.
- Skeleton consumer logs and acknowledges jobs. Verified live: an upload in the dev org produced `hook_accepted`, `job_queued`, then `job_received` on attempt 1, two seconds later.
- Test plugin's `createMessageBatch` and `getQueueResult` signatures checked in the installed types before writing consumer tests. 48 passing.

## 2026-11-02: Pipeline file access verified

- Phase 1 never tested file downloads, so it was checked before any consumer code. `scripts/Test-PipelineFileAccess.ps1` probes as the pipeline user through a real client-credentials token and prints only status codes, sizes and the first bytes, never the token, secret or contents.
- File on a checklist item: metadata OK, download OK (552,129 bytes, matching `ContentSize`, starts with `%PDF-`): PASS
- File linked to nothing (made for the test, then deleted): metadata and download both `404 NOT_FOUND`: PASS. To the pipeline, files outside applications don't exist.
- Finding: an unfiltered `ContentVersion` count returned 0 for the pipeline even though it can open application files by ID. Counts only show files a user owns, so it is no proof of scope; removed from the script. The by-ID negative test is the real check.
- Finding: every file in the org was already on a checklist item, so the negative case needed a purpose-made file.

## 2026-11-02: Consumer downloads from Salesforce

- Worker secrets `SF_CLIENT_ID`, `SF_CLIENT_SECRET` and `SF_INSTANCE_URL` piped from Credential Manager (`SafeDocumentIntake-SF`) and `sf org display`, never displayed. The instance URL is a secret too, to keep the login endpoint out of the public repo. `SF_API_VERSION` is a plain var.
- `src/salesforce.ts`: client-credentials token and `VersionData` download. Each failure is classed as retryable (429, 5xx, network) or not (404, other 4xx, missing token). Files over 10 MB are refused, from the declared length when there is one, before reading.
- `src/consumer.ts`: retryable failures go back to the queue; others are acknowledged and given up on. Anything unexpected is retried and logged by error type only, never its message. The last log line for a job carries `final: true`, which the D1 audit write will hang off.
- Bug caught by a test: the token URL was built inside the `try`, so a missing setting was reported as "Salesforce unavailable". Moved out.
- Incident: `SF_API_VERSION` was set to `68` instead of `68.0`. Salesforce answers 404 for an unknown version, so the live job was logged as `file_not_found` and given up on. It failed safe (one attempt, no retries), and the probe script proved the file was fine. Fix: the version is validated before any request, so a bad setting now surfaces as a bug, not a missing file. Pinned by a test.
- Verified live: an upload produced `job_downloaded` with 1,446,659 bytes on attempt 1, matching the file's `ContentSize` from the probe.
- 71 tests passing.

## 2026-11-02: Folder layout, Salesforce side

- Drive layout emulates the original SharePoint sync: `Safe Document Intake/Student-Admissions/<year>/<term>/<Last, First>/<Last First> <Doc Type> #n.pdf`. Neutral root name so nothing points at a real employer. Middle names dropped (the Contact field depends on an org setting, and the synthetic data doesn't use them).
- Improvement on the original, which found folders by name: D1 will map application ID to Drive folder ID, so duplicate names, name corrections and term changes can't misfile a document.
- New formula `Application__c.Applicant_Folder_Name__c` builds "Last, First" in Salesforce, where the parts are still separate, so the Worker never splits a full name.
- Deliberate grants to Intake_Integration, read-only: `Applicant_Folder_Name__c` and `Term__c`. The year comes from the term's last four digits, so no field for it.
- Finding: `Checklist_Item__c.Document_Type__c` is required, and a required field's access can't be set in a permission set; the deploy was refused. Required fields are readable by anyone who can read the object, so field-level security can't hide them. The pipeline already had it.
- Deploy reran `DocumentReviewRulesTest`: 11/11. Grants verified in `FieldPermissions`, not just the file.
- Live checks as the pipeline user (probe script now takes `-ChecklistItemId`, and prints a name's length and shape, never the name):
  - The Worker's exact query: type, term and a "Last, First" folder name: PASS
  - `Application__r.Applicant__r.LastName`: `400 INVALID_FIELD`. The formula doesn't open a path to the Contact: PASS

## 2026-11-02: Drive client, naming rules and D1 records (not yet wired in)

- Google secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` piped from Credential Manager. The refresh token is the real key: a desktop-app client secret isn't treated as confidential by Google.
- `src/drive.ts`: refresh token to access token, folder creation, resumable upload. Google's docs limit multipart uploads to 5 MB, under our 10 MB cap, and recommend resumable uploads for most apps, so every upload is resumable (two requests).
- Guards: the token's scope is checked on every exchange and anything beyond `drive.file` is refused; the upload session URL from Google's `Location` header must be `https://www.googleapis.com/upload/drive/v3/files...` before any bytes are sent (tested with another host, plain http, a non-upload path and no header, each sending no bytes); Google's 403 rate limits retry while real 403s don't. Files carry their Salesforce record IDs in private `appProperties`.
- `src/layout.ts`: naming rules, pure functions. Strips characters Windows forbids, so downloaded files work anywhere, and a name can't contain a path separator. A bad term, name or type is a data problem and gives up rather than retrying.
- Migration `0002_drive_records.sql`: `drive_folders` (keyed by what a folder is, never its name) and `drive_uploads` (keyed by ContentVersion, for idempotency, with a unique index so `#n` can't repeat). Applied remotely and verified.
- 117 tests passing.

## 2026-11-02: End to end, Salesforce to Drive

- Consumer now: idempotency check, Salesforce token, checklist item details and file extension, naming check, download, Google token, folder chain, `#n`, resumable upload, D1 record. Naming data is checked before the download, so bad data fails without fetching a file.
- `src/deliver.ts`: each folder level is found by its D1 key and only created in Drive if it has never existed. The student folder is keyed by application ID.
- A redelivered job whose ContentVersion is already in `drive_uploads` is acknowledged without calling Salesforce or Google. Tested.
- Naming problems (`LayoutError`) give up rather than retry; unexpected errors retry and log only their type.
- Known gap, logged rather than hidden: if the upload succeeds and the D1 record fails, the retry uploads a second copy. Rare, visible and harmless; the private `appProperties` tag is what a later fix can use to find the file before re-uploading.
- Known gap: a folder deleted by hand in Drive stays in D1, so uploads to it would fail. For the reconciler or a hardening pass.
- Verified live: an upload produced `job_uploaded` (sequence 1, 775,362 bytes, attempt 1) three seconds after the webhook. Drive shows `Safe Document Intake/Student-Admissions/2026/Fall 2026/Delgado, Noa/Delgado Noa Resume #1.pdf`, 757 KB, opening correctly. D1 holds the five folder keys and one upload row.
- 122 tests passing. Phase 2 remaining: audit trail in D1, scheduled reconciler.

## 2026-11-02: Append-only audit trail

- Migration `0003_audit_log.sql`, matching the gateway's `audit_log` (autoincrement ID, ISO timestamp, `CHECK` on the event, metadata only), with one step further: `BEFORE UPDATE` and `BEFORE DELETE` triggers make it append-only by enforcement, not just by comment.
- Events: `queued` (webhook), `uploaded`, `already_uploaded`, and `failed` on every attempt, with reason, attempt number and `final`. The failure row is written before the retry or give-up, so the record outlives the message's 24-hour DLQ retention.
- Writes are best-effort: a failed audit write is logged and never blocks an upload or turns a success into a retry. The webhook writes its row with `waitUntil`, off the response path.
- Malformed messages get no audit row: they have no trustworthy IDs to record.
- D1 accepted the triggers (verified in `sqlite_master`).
- Verified live: a second Resume upload produced `job_uploaded` with sequence 2 (`Delgado Noa Resume #2.pdf`), and the audit log shows `queued` then `uploaded`.
- Tamper test in production: `UPDATE audit_log ...` through Wrangler, with a valid token, was refused with `audit_log is append-only: SQLITE_CONSTRAINT_TRIGGER`: PASS
- 126 tests passing (audit assertions added to existing consumer and webhook tests).

## 2026-11-02: Scheduled reconciler; Phase 2 complete

- Hourly cron (`17 * * * *`, off the top of the hour). `triggers.crons` confirmed in the installed Wrangler schema before use.
- Probe first: the reconciler's query, as the pipeline user, saw 62 latest versions on 101 checklist items, matching the admin's count of 62. `-ListFiles` added to the probe script.
- Finding: today's test uploads were new versions of one file, not new files, so the reconciler (latest version only) correctly doesn't resurrect older versions.
- `listLatestVersions` follows `nextRecordsUrl` only if it's a same-org query path, since the bearer token goes wherever it points. Tested with another host and a non-query path. More than 50 pages is treated as an error.
- Missing versions are queued as ordinary jobs, at most 100 per run (one `sendBatch`). Given-up versions are skipped and left for a person. Duplicates are harmless thanks to the consumer's idempotency check.
- Reconciler jobs are audited as `queued` with reason `reconciler`, avoiding a `CHECK` change on an append-only table. Rows are written after the send, in one D1 batch.
- First live run at 4:17 PM: found 62, already uploaded 1, given up 0, queued 61, deferred 0. All 61 uploaded on attempt 1, zero failures, in 3 minutes 47 seconds, including Friday's test file.
- Verified in D1: 63 uploads (Noa Delgado's #1 predates the audit log, so the log shows 62), 29 folders (8 structural plus 21 students, one per application with a file), 0 failures.
- Measured pace: about one job every 3.5 seconds, roughly 17 a minute. That's above Gemini Flash-Lite's 15 requests per minute, so Phase 3 must slow the consumer down.
- Practice: run Wrangler from `worker/`. From the repo root, `npx` found Wrangler 4.69.0 and skipped `wrangler.jsonc`, including the pinned `account_id`.
- Phase 2 complete: signed trigger, queue, consumer, Salesforce download, Drive upload in the original sync's layout, append-only audit trail, hourly reconciler. 133 tests passing.

## 2026-11-02: Phase 3 design, and the audit log rebuilt for a second stage

- Phase 3 design: screening runs on its own queue (`screen-documents`), fed after a successful upload. Uploads stay fast and independent of Gemini; a failed screening never redoes an upload. Cost: the screener downloads the file again from Salesforce, kept as the single source of truth (queue messages max out at 128 KB).
- Pacing well under the free tier on purpose: 8 seconds between Gemini calls (about 7.5 a minute, half of 15) and a 200-a-day cap (40% of 500). Spent budget means a delayed retry, at most 12 hours (Cloudflare's limits page gives 12 in one version and 24 in another, so the design works under either). Max retries can go to 100. The reconciler will also catch files in Drive with no review.
- Migration `0004_audit_log_stages.sql` rebuilds `audit_log` with `stage` (`intake`/`screen`, default `intake`), the events `screened`, `already_screened` and `deferred`, and a `model` column. SQLite can't change a `CHECK` in place.
- Honest scope of "append-only": the triggers stop the Worker and ordinary queries from rewriting history (proven twice in production). A schema migration can still drop them, and this one did, to rebuild the table. That's the deliberate exception, done once, logged here.
- Safeguards for the live run: before/after fingerprint (124 rows, IDs 1 to 124 with sum 7,750, so no gaps; 62 versions; first and last timestamps) matched exactly. A D1 Time Travel bookmark was taken first, for a full restore if anything differed. All 124 rows now read `intake`, and the tamper test still fails with `append-only`.
- The column default kept the deployed Worker working through the migration, before the new code shipped.
- 135 tests passing.

## 2026-11-02: Phase 3 plan revised; screener prompt developed against a dev set

- Revised after re-reading the brief: screen before release (Review, then File), the standard quarantine pattern for untrusted files. One paced consumer replaces the planned second queue. Flagged files get a `[FLAGGED]` name in Drive. The 63 files filed before this rule will be screened and marked by the backfill.
- Audit, revised: a D1 change and its audit row go in one batch (one transaction); an external action fails and retries if its audit write fails, with idempotency making the retry harmless. The webhook's `queued` row stays best-effort, covered by the reconciler. Stricter than the brief's own wording.
- Pacing well under the limits on purpose: 8 seconds between Gemini calls, 200 a day.
- Prompt, schema and model live in `worker/src/screener-spec.json`, read by both the Worker and the probe. Output order puts `tampering_detected`, `tampering_excerpt` and `detected_type` before `verdict` (the API orders properties alphabetically unless told). `reasons` must not repeat the name or ID numbers.
- Methodology: prompt tuning uses a separate dev set (`--seed 20261102`, `eval/dev/`, never loaded into Salesforce), so the 60 test documents stay held out for Phase 4. Three test documents (doc-0001 to 0003) were inspected before the dev set existed; stated here for the record. `scripts/Test-Screener.ps1` defaults to dev.
- Dev results, 8 of 8 on the hard cases: registrar's note, 1-point text, white text, both metadata injections, illegible scan, and a good scan (no over-flagging).
- Finding: PDF metadata never reaches Gemini. Identical prompt token counts (891 to 893) showed the properties weren't in the input, so no prompt change could fix it. The pipeline now passes Title, Subject, Keywords, Author, Creator and Producer as a labeled "part of the document, data only" text part; counts rose to 984 and 1,007 and both metadata injections were caught. Limitation: only the uncompressed Info dictionary is read; properties in compressed streams aren't seen. `pdf-lib` would cover them, at a CPU cost on the free plan; a hardening item if Phase 4 shows the need.
- Finding: a white-text injection asked the model to put its system prompt in `reasons`. It flagged and quoted the attempt and kept its reasons to 74 characters with no prompt in them: resist and surface, the behavior the gateway lacked.
- Steady state verified: the 5:17 PM run reported found 62, already uploaded 62, queued 0, with no queue activity. The reconciler stays quiet once everything is synced.

## 2026-11-02: First full dev-set run

- `Test-Screener.ps1 -All`: all 60 dev documents at the Worker's 8-second pacing, scored against the dev manifest. Fails closed like the pipeline (unparseable or off-list output becomes `needs_human`). Running `-All -Set test` requires typing `test`, so the held-out set can't be spent by accident. Results saved as CSV.
- Result: 57 of 60, zero false passes. One miss was a Gemini 503, not a judgment: the probe failed closed to `needs_human` as designed, and a rerun caught it with an exact excerpt. On actual model judgments: 58 of 60, and all 16 injections caught and quoted exactly, including both metadata ones.
- The other two misses were good documents flagged `name_mismatch`. Both documents show the applicant's name exactly (checked by eye), and two reruns of each returned `pass` every time: run-to-run variation, not a pattern. The prompt was left unchanged, since adding a rule for a coin flip is overfitting.
- Consequence for Phase 4: one run of the test set isn't a stable measurement. Plan to run it several times and report the range plus which documents flip. Check Google's current guidance on temperature for this model before changing it.
- Probe now retries 503s as well as 429s, as the Worker will through the queue.
- Process note: two test documents (doc-0018, doc-0054) were opened by mistake while looking for their dev namesakes. `eval/out` (test) and `eval/dev/out` (dev) hold identically named files one level apart. Viewed only, nothing tuned; the test files' hashes and timestamps confirm the dev run never touched them. Restructuring to `eval/test/` and `eval/dev/` is first on the next session's list.

## 2026-11-03: Eval sets restructured

- Each eval set now lives in its own folder holding everything for that set: `eval/test/` and `eval/dev/`, each with `pdfs/`, `plan.json`, `manifest.json` and (for test) `load_result.json`. The old `out/` subfolders are gone.
- `generate.py`, `load.py` and `scripts/Test-Screener.ps1` updated to the new paths, docstrings included.
- `.gitignore` now uses set-agnostic rules (`eval/*/pdfs/`, `eval/*/plan.json`, `eval/*/load_result.json`). Manifests stay committed as the answer keys.
- Verified the move: a fresh generation into a temp folder matched all 60 test PDFs byte for byte.
- Finding: the regenerated manifest's hash differed even though its content matched. Two causes: Python on Windows writes CRLF while `.gitattributes` pins LF, and the precommit hook's `prettier --write` adds a trailing newline to committed JSON. `generate.py` now writes LF with a final newline, so a fresh manifest is byte-identical to the committed one.

## 2026-11-03: Screener request builder and fail-closed parsing

- `worker/src/screener.ts` builds the Gemini request from `screener-spec.json` and turns the answer into a verdict. 20 new tests.
- Payload guarantee is structural: `buildRequest` destructures only the PDF, the filed type and the applicant name. The test passes an application ID and email alongside and asserts neither reaches the request body.
- Document properties are read from the uncompressed Info dictionary and sent as a separate part, deduplicated, the same as the probe. Same limitation: properties in compressed streams aren't seen.
- Templates are filled in one pass through a function replacement, so a `$&` or `{type}` inside a name is inserted literally.
- Base64 via `btoa` over a chunked byte-to-string conversion (no `nodejs_compat`, so no `Buffer`); tested with a 3 MB file.
- Fail closed: a missing candidate, non-STOP finish, missing or non-JSON text, off-list verdict, wrong field types or reasons over 300 characters all become `needs_human`, with the cause in `failure`. Nothing throws.
- Exception for tampering: if the flag or the verdict signals tampering, a rejected answer still comes out `tampering_suspected` with its excerpt, so the reviewer's warning doesn't depend on the model formatting everything correctly.
- Full suite: 155 passing across 12 files.

## 2026-11-03: Gemini pacing in D1

- `worker/src/pacing.ts` with migration `0005_gemini_pacing.sql`: every Gemini call is reserved in D1 first, at most one per 8 seconds and 200 a day, well under the free tier's 15 a minute and 500 a day.
- One `INSERT ... SELECT ... WHERE` checks both limits and records the call in a single statement, so two runs can't both slip through. A refusal says which limit and how long to wait: the rest of the gap, or an hour once the day's budget is spent.
- Days are counted in Pacific time, since that's when Google resets the daily quota (per the Gemini rate limits docs). Tested on both sides of midnight in winter (UTC-8) and summer (UTC-7).
- A call that fails after its reservation still counts, since Google counts the request too. Rows are kept, which leaves a per-day call history for the write-up.
- 8 new tests; full suite 163 passing across 13 files. Migration applied to the live `AUDIT_DB`, table confirmed empty.

## 2026-11-03: Screener details on Document_Review__c

- New fields `Detected_Type__c` (text 255, what the screener read the document as) and `Screen_Failure__c` (text 40, why an answer was rejected and the verdict failed closed; blank when accepted). Filterable, so Phase 4 can count failures by cause without parsing reasons.
- `Verdict_Is_Immutable` now covers both, so they're locked after creation like the rest of the first pass, admins included.
- Field access: Integration and Admin read and edit (Integration still can't update reviews, since it has no object edit), Reviewer read only. Verified live through `FieldPermissions`.
- New Apex test `screenerDetailsAreSetOnCreateThenLocked`: the pipeline user sets both fields on insert through its own permissions, then admin edits to either (including clearing the failure code) are blocked.
- Apex: 12 review-rule tests and 9 trigger-sender tests passing. Finding: the CLI's "Tests Ran" counts each `@TestSetup` method as a test, so it reads 2 higher than the real count.

## 2026-11-03: createReview

- `createReview` in `worker/src/salesforce.ts` files the screener's first pass as a `Document_Review__c`, as the pipeline user. 9 new tests with a mocked `fetch`.
- Never sends `Decision__c`: it defaults to Pending, and the pipeline has no edit access to it.
- A replayed job gets `DUPLICATE_VALUE` from the unique file-version field and returns `duplicate`, so the consumer can treat the file as already reviewed.
- Model output is trimmed to each field's length without splitting a two-part character, so an overlong answer can't fail the insert and lose the verdict. Empty values are left out, not sent as blanks.
- Transient failures (network, 429, 5xx) are retryable; validation errors and a success without an ID are not.
- No live insert yet, on purpose: reviews can't be deleted, so a probe record would stay in the audit trail. The first real one comes with the reordered consumer.
- Full suite: 172 passing across 14 files.

## 2026-11-03: [FLAGGED] file naming

- `fileName` in `worker/src/layout.ts` takes an optional `flagged` flag (default false, so existing callers are unchanged) and prefixes `[FLAGGED] ` to the Drive name. The `#n` sequence is unaffected, since it comes from D1's count per application and document type.
- Brackets are now stripped from the person's name, so only the pipeline can produce the marker: an applicant named `[FLAGGED] Shah` in Salesforce gets `FLAGGED Shah ...`, never a look-alike flag. A name that is nothing but brackets is rejected as missing.
- Layout stays verdict-agnostic; the consumer decides which verdicts are flagged.
- 4 new tests; full suite 176 passing across 14 files.

## 2026-11-03: Consumer reordered to review, then file

- Per job: details, naming check, download, Drive token (moved up, so a bad Google token fails before a review is filed or a Gemini call is spent), then screen, `createReview`, upload, and the upload record with its audit row in one D1 batch.
- Review before file: the verdict is in Salesforce before the file reaches Drive, so a flagged file is never in Drive unmarked. `tampering_suspected` files are named `[FLAGGED] ...`.
- Redeliveries reuse the filed verdict (`findReview`), so a crash between review and upload costs no second Gemini call and can't produce a second, different verdict. If `createReview` loses a race (`DUPLICATE_VALUE`), the earlier delivery's verdict stands.
- Pacing waits never use up a job: a short gap retries with a delay; a spent daily budget, or a wait on the last attempt, acks and leaves the job to the hourly reconciler.
- A document is never lost to the screener: an outage retries, but on the last attempt, or when Gemini refuses the request, the file is still filed, held for a person (`needs_human`, with `screen_unavailable` or `screen_rejected`). `Model__c` reads `unscreened` whenever no model answered.
- Screening is PDF-only. Other files are filed as `needs_human` with `unsupported_format`, without calling Gemini. What .docx screening would take is drafted in `docs/drafts/docx-extension.md`.
- The Gemini key is sent in a header, never the URL. The applicant name is fetched for the screener only and never used in names or logs.
- Known limitation, unchanged: if Drive accepts the file but the D1 batch then fails, the retry uploads a second copy.
- Finding: `getQueueResult` records that a message was retried but not its delay, so the pacing test watches `message.retry` directly.
- Consumer tests rewritten: 22 (was 12). Full suite 186 passing across 14 files.

## 2026-11-03: First live end-to-end run

- `GEMINI_API_KEY` set as a Worker secret, piped from Credential Manager; deployed as version `0f24566e`.
- Smoke test with a one-off synthetic personal statement (made in the git-ignored `eval/scratch/`, so neither eval set was touched), attached by the admin to an empty checklist slot with `sf data create file`.
- Result, first attempt: signed hook accepted and queued, screened `pass` by `gemini-3.5-flash-lite` (detected type "Personal Statement", no screen failure), review filed as `Pending` by the Intake Pipeline user, then uploaded to Drive as `#1`, unflagged.
- Audit trail: `queued`, then `screen`/`screened` (`pass`) about 5 seconds later (the Gemini call), then `uploaded` 2 seconds after that. About 7 seconds from attach to Drive.
- The reasons text followed the prompt's rule: no applicant name, no ID numbers.
- Finding: wrangler D1 commands in a terminal without the intake token loaded fail with 7403 ("account not valid or not authorized"), not an auth prompt. Load `Use-IntakeCloudflare.ps1` in every terminal that talks to Cloudflare.

## 2026-11-03: Screening backfill, test set held

- Decision: backfill screening only for files outside the eval test set. The 60 test files stay unscreened until a deliberate Phase 4 run, so new backfill code never debuts on data that can't be rerun (reviews can't be edited or deleted).
- `screen_holds` (migration 0006) lists versions the pipeline must not screen. `eval/hold_test_set.py` builds the holds from `load_result.json`, refusing anything but exactly 60 valid ContentVersion IDs. Loaded live; verified 60 holds, all 60 matching a file in Drive. Phase 4 releases them with one `DELETE`.
- The consumer now finishes files filed before screening existed: if one is in Drive with no screening row and no hold, it is screened (or its existing review reused), and renamed to `[FLAGGED] ...` if flagged, keeping its number. The file never moves.
- The screening audit row is written last, after any rename, so "screened" in the audit log means fully finished. A failed rename leaves no row, so the retry, or the next hourly run, renames it, reusing the filed verdict without screening again.
- The reconciler queues in-Drive files that have no screening row and no hold, and reports `unscreened` and `held` counts.
- `renameFile` in `drive.ts` (PATCH, allowed under `drive.file` for files the app created).
- 7 new tests (5 consumer, 2 reconciler); full suite 193 passing across 14 files.

## 2026-11-03: Backfill run, live

- Deployed as version `9ecf2000`. The 1:17 PM reconciler run found 63 files: 60 held (test set), 1 already finished (the smoke test), 2 unscreened and queued. The held files never reached the queue.
- Both backfilled files were placeholders from earlier probes (a mock CPT application and a flyer), filed on slots for other document types. Both screened `wrong_type`, correctly, with detected types "CPT Application" and "promotional flyer", and no renames needed.
- Pacing, live: the second job arrived 6 seconds after the first, was deferred (`too_soon`, retry in 3 s) and finished on attempt 2.
- Org check: exactly 3 `Document_Review__c` records, all filed by Intake Pipeline with `gemini-3.5-flash-lite`. The test set is untouched.

## 2026-11-03: Roboflow classification experiment

- Separate from the pipeline and Phase 4: `experiments/roboflow/run_eval.py` scores a Roboflow-trained classifier (DINOv3 Small, six classes) on its held-out test split through the Serverless Hosted API v2. No Worker, Salesforce, Drive or secret changes. The key lives in a gitignored `.env` and travels as an Authorization header, verified in the SDK source and a dry run.
- Result: 11 of 12 correct, matching Roboflow's own evaluation. The one miss, `doc-0059`, a personal statement read as a recommendation letter, came with 0.66 confidence.
- At a 0.70 threshold, 9 predictions would auto-update the checklist (all correct) and 3 would go to staff review, including the miss. The threshold was chosen on these same 12 images, so it needs validating on new documents.
- Caveat: 12 synthetic images, a lopsided split. A working setup, not evidence of production reliability.
- Finding: installing `inference-sdk` into the eval venv downgraded Pillow from 13.0.0 to 12.3.0, and 18 of 60 regenerated test PDFs then differed. Pillow 13 was restored (all 60 identical again), and the experiment got its own venv. The generator is reproducible from the seed _and_ Pillow 13.0.0, so that version should be pinned.

## 2026-11-03: Phase 3 complete, reviewer side live

- The Safe Agent Gateway now exposes two read-only document review tools (`list_document_reviews`, `get_document_review`; gateway commit `0119314`). Screener text is returned inside an untrusted block; there is no decide tool, and decisions stay with a person in Salesforce.
- Live demo through the claude.ai connector: Claude listed the 3 pending reviews, opened the oldest, presented the screener's reasoning as reported data, and left the decision to a person in Salesforce.
- The same session showed the gateway's prompt-injection fixture (in APP-00065's review notes) treated as data and not repeated.
- Finding: the claude.ai connector caches a server's tool list. New tools appeared only after disconnecting and reconnecting the connector, not in a new chat alone.
- Small follow-up: define "flagged" (tampering_suspected only) in the list tool's description; the demo agent applied the word to wrong_type reviews.
- Next: Phase 4, the held-out test set run.

## 2026-11-03: Phase 4 freeze

- Screener spec frozen: `worker/src/screener-spec.json`, SHA-256 `ceca6820b81ff41f07bbd4637d8e272bd1bd6838386aa041dce8c09ef6a927e2`, last changed in `cd593c9` (Nov 2). Model `gemini-3.5-flash-lite`. Tagged `phase4-freeze`.
- Scoring written and committed before release: `eval/score_phase4.py` joins the answer key, `load_result.json` and the live `Document_Review__c` records. It reports verdict accuracy, injections caught by style (with exact-excerpt checks), unsafe passes, false tampering flags, clean documents held back, prompt leaks, name echoes, fail-closed answers, a confusion matrix and every wrong verdict. Tested on stand-in data covering each failure type; a dry run against the org found 0 of 60 reviews, correct while held.
- Found before release: the reconciler sent its whole batch at once, so all but one job hit the pacing gap, retried together and collided again, each retry spending a queue attempt (about 6 documents an hour). It now staggers sends by 10 seconds (the 8-second gap plus margin), so the 60 should finish in one run of about 10 minutes. 1 new test; 194 passing.
