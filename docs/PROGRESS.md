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
