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
