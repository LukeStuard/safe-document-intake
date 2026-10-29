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
