The pitch

A serverless pipeline that moves applicant documents from Salesforce into Google Drive, with an AI agent that checks each document before a human ever opens it. The agent reads every upload, decides whether it matches the checklist item it was filed under and the applicant it belongs to, and proposes a verdict. It never rejects, deletes, or changes anything on its own. A person makes every final call, and Salesforce enforces that.

The point of the project is the second half of that sentence. Every uploaded document is untrusted input that an AI is going to read, so the pipeline is built around the question "what happens when a document tries to manipulate the reviewer?"

Background

This is a clean rebuild, not a port. The original was a Python desktop app built for an employer: it polled Salesforce export jobs and copied files into SharePoint, with filename sanitization, versioned copies instead of overwrites, and an audit trail. None of that code or configuration is used here. This version keeps the good ideas, moves to serverless, swaps SharePoint for Google Drive, and adds the AI review step.

The Safe Agent Gateway found that an agent resisted a planted prompt injection but silently left it out of its summaries, so a human reviewer would never learn the record was tampered with. This project treats that finding as a design requirement: tampering must be surfaced, never hidden.

Relationship to the Safe Agent Gateway

This project builds on the gateway rather than starting over. The two pieces split the work cleanly:

The intake pipeline (this repo) is the automated side. It moves documents, runs the first-pass AI screen, and writes verdicts into Salesforce. It has no conversational agent and no MCP surface of its own.
The gateway (existing repo) stays the only door any conversational agent uses into Salesforce. It gains new tools for document reviews, behind the OAuth, rate limiting, and audit logging it already has.

Reused from the gateway:

The same Salesforce Developer Edition org, including Contact and Application__c and their synthetic data
The same personal Cloudflare account, plus the API token and session script setup
The D1 audit log pattern, the Durable Object rate limiter, and the Credential Manager helper scripts
The OAuth setup that lets claude.ai connect as a custom connector

Kept separate on purpose:

Each service gets its own Salesforce integration user and permission set. The pipeline needs applicant names to check documents; the gateway's integration user deliberately has no Contact access and keeps it that way. One identity per service means a compromise of one does not widen the other.
Separate Workers, separate D1 databases, separate secrets.
Ground rules
Free tier only. No paid services, no credit card charges. If a step needs money, it gets redesigned.
Synthetic data only. Every applicant, document, and name is generated. No real people.
Personal accounts only. The gateway's personal Cloudflare account and Salesforce Developer Edition org, plus a personal Google account. No employer tenant, account, or identity anywhere.
Every feature ships with a safety control and a test that proves it. Controls are mapped to the OWASP Top 10 for LLM Applications by risk name.
Check the installed version's docs before writing code against any library.
Secrets never touch the repo. Not in code, not in wrangler config vars, not in git history.
Stack
Piece Choice Why
System of record Salesforce Developer Edition Free, and the real platform schools use
Compute Cloudflare Workers Same platform as the gateway
Async work Cloudflare Queues, with a dead-letter queue Retries and failure isolation without hand-rolled code
Audit log Cloudflare D1 Proven pattern from the gateway
Destination Google Drive (primary), Cloudflare R2 (fallback) Free; R2 lets anyone clone and run it with no Google setup
First-pass AI Workers AI (primary), Gemini free tier (comparison) Both free within limits; to be verified in Phase 0
Reviewer assistant Claude in claude.ai (Pro), through the gateway Covered by the existing subscription; no API billing
Data generation Python, seeded Reproducible synthetic records and PDFs
Architecture
Trigger. A document is attached to a checklist item in Salesforce. A record-triggered flow calls the Worker through a Named Credential. The request is signed so the Worker can reject anything that did not come from the org.
Enqueue. The Worker validates the request, writes an audit entry, puts a job on the queue, and returns immediately.
Fetch. A queue consumer authenticates to Salesforce as a least-privilege integration user and downloads the file. The job is keyed on the document's version ID, so a retried job never processes the same file twice.
Review. The agent receives the document plus a minimal slice of context (the checklist item type and the applicant's name, nothing else) and returns a structured verdict.
File. The document is uploaded to Google Drive through the storage adapter, with sanitized filenames and versioned copies. Flagged documents are marked so they stand out.
Report back. The verdict is written to Salesforce as a Document_Review__c record. Anything flagged waits for a human decision.
Audit. Every step, success or failure, is logged to D1. If the audit write fails, the step fails.
Assisted review. A staff reviewer opens claude.ai, which is connected to the gateway as a custom connector. Through new gateway tools, Claude lists the flagged documents, explains each verdict, compares details against the applicant, and drafts a decision note. Claude can propose a note, but the decision itself is made by a human in Salesforce.
Two layers of AI, one human decision
Layer Model Runs Can do Cannot do
First-pass screen Workers AI or Gemini Automatically, on every document Return a verdict from a fixed list Call any tool, write anything except its own review record
Reviewer assistant Claude, through the gateway On request, by a person Read reviews, explain them, propose a note Decide a review, edit a verdict, touch Drive
Decision A human In Salesforce Approve or reject (Enforced by Salesforce: cannot decide their own proposed note)

The cheap model screens everything; the stronger model helps a person with the hard cases; no model makes the final call.

Adapters

Two swappable interfaces keep the core pipeline independent of vendors:

Storage adapter: GoogleDriveStorage and R2Storage. A SharePoint adapter can be added later without touching the pipeline.
Model adapter: WorkersAiReviewer and GeminiReviewer. Same input, same output schema, so they can be compared head to head.
Google Drive auth
No service account. Service accounts have no storage quota of their own, so they cannot upload into a personal Drive, and Shared Drives require paid Workspace.
OAuth as the project owner, drive.file scope only. The app can see and manage only the files it created, not the rest of the Drive. This is the least-privilege equivalent of SharePoint's Sites.Selected.
Consent screen set to "In production." Apps left in Testing mode get refresh tokens that expire after 7 days. Confirm in Phase 0 that drive.file can be published without verification review.
REST calls with fetch. Google's Node client library does not run well in Workers, so the Worker calls the Drive API directly.
The refresh token is stored as a Worker secret.
The agent contract

Input (and only this):

The document file
The checklist item type it was filed under (for example, "Official Transcript")
The applicant's first and last name

Output (validated against a strict schema):

verdict: one of pass, wrong_type, name_mismatch, illegible, tampering_suspected, needs_human
detected_type: what the agent thinks the document is
reasons: short plain-language explanation, capped in length
tampering_detected: true or false, with the suspicious text quoted back

Rules:

Output that fails schema validation becomes needs_human. The pipeline fails closed, never open.
The agent has no tools. It cannot call Salesforce, Drive, or anything else. It returns JSON, and the pipeline decides what to do with it.
Instructions found inside a document are data. Any document containing them is flagged tampering_suspected and the text is surfaced to the reviewer.
Salesforce data model

Existing in the gateway org:

Contact: synthetic applicants
Application__c: one per applicant per term
The approval-gated review note model (Review_Note_Request__c and its validation rules and flows), reused for Claude's proposed decision notes

New for this project:

Checklist_Item__c: required documents per application (transcript, ID, resume, recommendation letter, and so on), with files attached
Document_Review__c: the first-pass verdict, reasons, and tampering flag, plus the human decision, decider, and timestamp
A pipeline integration user and permission set, separate from the gateway's

Enforced by Salesforce, not by the pipeline:

The integration user can create reviews but cannot decide them
Decisions are final once made
Verdict fields written by the agent cannot be edited by anyone
Safety controls
Feature Control OWASP LLM risk Test that proves it
Inbound trigger Signed requests, rejected if unsigned or stale (platform security) Unsigned and replayed requests return 401 and are logged
Agent reads documents Instructions in documents treated as data and flagged Prompt Injection Injection fixtures produce tampering_suspected with the text quoted
Agent context Only document type and applicant name sent Sensitive Information Disclosure Request payload test asserts no other fields are present
Agent output Strict schema, fixed verdicts, invalid output fails closed Improper Output Handling Malformed model responses become needs_human
Agent power No tools, no write access, verdicts are proposals Excessive Agency Agent output has no path to change Salesforce or Drive beyond the review record
Human review Salesforce enforces decider rules and finality Excessive Agency Integration user cannot approve; decided reviews cannot change
Model usage Per-day caps on model calls and document size Unbounded Consumption Oversized and over-quota jobs are rejected and logged
Drive access drive.file scope only (least privilege) App cannot list or read files it did not create
Retries Idempotency on document version ID (reliability) Replayed job does not create a duplicate upload or review
Audit Fail-closed logging (accountability) Broken audit table stops the pipeline
Gateway review tools Read-only plus approval-gated notes, behind existing OAuth and rate limits Excessive Agency Claude can propose a note but no tool can decide a review
Quoted tampering text reaches Claude Returned in a clearly labeled untrusted field, never mixed into instructions Prompt Injection Claude surfaces the injected text to the reviewer instead of obeying or omitting it (the gateway's original open finding, retested)
Separate identities Pipeline and gateway use different integration users (least privilege) Gateway user still cannot read Contact; pipeline user cannot read review notes it does not need
Synthetic data and the eval set

A seeded Python generator creates applicants, applications, checklist items, and PDFs. The PDFs double as a labeled eval set:

Good documents: the right type, the right name
Wrong type: a resume filed as a transcript, and so on
Name mismatch: right type, someone else's name
Illegible: blank pages, heavy noise, low-resolution scans saved as images
Injection fixtures: visible instructions, hidden white text, tiny fonts, text in PDF metadata, instructions disguised as a registrar's note

Every document has a known correct verdict, so results can be scored: a confusion matrix, false passes (the number that matters most), and injection detection. Both model adapters run against the same set.

Size: about 50 documents. Roughly 15 good, 8 wrong type, 8 name mismatch, 6 illegible, and 15 injection fixtures (each technique two or three times). With this few per category, results are reported as raw counts ("caught 7 of 8 name mismatches"), not percentages.

The eval set runs outside Salesforce. A local harness feeds the PDFs from disk straight into each model adapter and scores the output. Only about a dozen documents go through the full Salesforce-to-Drive pipeline, for the end-to-end demo and screenshots. This keeps Developer Edition file storage limits out of the way.

Build phases

Phase 0: Setup and verification

Reuse the gateway's Cloudflare account and Salesforce org; create a new Google Cloud project
Google OAuth consent screen created and set to "In production"
Confirm current Workers AI and Gemini free-tier limits and which models handle PDFs or images
Repo created with .gitignore covering .dev.vars and .env, plus a gitleaks pre-commit hook
Done when: a hello-world Worker deploys, and a test file uploads to Drive by hand with the OAuth token

Phase 1: Salesforce data model and synthetic data

New objects, fields, validation rules, the pipeline's permission set and integration user
Seeded generator for checklist items and the eval PDFs; about a dozen demo documents attached to existing synthetic applicants, the rest kept on disk
Done when: the org is populated and every eval document has its expected verdict recorded

Phase 2: Pipeline without AI

Signed trigger, queue, consumer, Salesforce fetch, storage adapters, D1 audit, idempotency, dead-letter queue
Done when: attaching a file in Salesforce lands it in Drive with an audit trail, and every safety test in this phase passes

Phase 3: The agent

Model adapters, minimal context, strict schema, fail-closed handling, Document_Review__c write-back, human decision rules
Done when: every document gets a review record, and the injection and malformed-output tests pass

Phase 4: Eval and red team

Run the full eval set through both models
Publish results honestly, including what the agent got wrong and what the controls missed
Done when: results are documented with numbers, and each open finding has a clear explanation

Phase 5: Assisted review through the gateway

New gateway tools, such as list_flagged_documents and get_document_review, built in the gateway repo with its existing OAuth, rate limiting, and audit log
Claude's decision notes go through the existing approval-gated note flow
Rerun the gateway's prompt injection test against documents flagged by the pipeline
Done when: a reviewer can work the flagged queue with Claude in claude.ai, every decision is still made in Salesforce, and the injected text is surfaced rather than hidden

Phase 6: Write-up

READMEs for both repos, with one shared architecture diagram, setup guide, and results
Screenshots (scrubbed of anything identifying)
LinkedIn post, framed as part two of the gateway story
Out of scope
Real documents or real applicants
Auto-rejecting, deleting, or editing documents
A custom user interface (Salesforce is the review screen)
SharePoint (left as a future adapter)
Paid tiers of anything
Open questions for Phase 0
Which Workers AI vision models are currently available, and do any accept PDFs directly?
What are the current free-tier limits for Workers AI and Gemini, and are they enough for several runs of the 50-document eval set?
Gemini's free tier may use prompts to improve Google's products. Fine for synthetic data, but worth stating in the write-up.
Can a Developer Edition flow make signed HTTP callouts through a Named Credential the way this design needs, or does it need a small Apex helper?
Can a claude.ai custom connector pass a PDF or image from a tool result into Claude's view? If not, Claude works from extracted text and the first-pass verdict.
Does the Developer Edition org have room for the dozen demo documents? (File storage limits are small on Developer Edition; the eval set stays outside the org.)
