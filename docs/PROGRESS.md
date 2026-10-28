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
