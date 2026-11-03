## Extending screening to Word documents (.docx)

The sync files any attached document to Drive, .docx included. Only screening is PDF-only: Gemini reads PDFs visually but treats other document types as plain text, and a .docx is a zip archive, not text. Today a non-PDF file is filed with a `needs_human` review and `Screen_Failure__c` set to `unsupported_format`, without calling the model.

To screen .docx files:

1. **Extract the text in the Worker.** Unzip with a small Workers-compatible library such as fflate, then read text from `word/document.xml`, headers and footers (`word/header*.xml`, `word/footer*.xml`), footnotes and endnotes, comments (`word/comments.xml`), and document properties (`docProps/core.xml`, `docProps/app.xml`).
2. **Keep what a reader can't see.** Include hidden text (runs marked `w:vanish`), tracked insertions and deletions, comments and field codes, each labeled as such. These are the easiest places to hide an injection in Word, so the screener must see them even when a reviewer opening the file would not.
3. **Send it as labeled text.** Replace the PDF part with a text part marked as document content and data only, the same way PDF properties are passed today, and adjust the system prompt so legibility judgments don't apply to extracted text.
4. **Add eval fixtures.** Generate .docx counterparts for each category (good, wrong type, name mismatch, injection), plus Word-specific injection styles: hidden text, a tracked change, a comment, a document property. Without these, Phase 4 results say nothing about .docx.
5. **Check the CPU cost.** Unzipping and parsing run inside the Worker's per-request CPU budget on the free plan. Measure with large files before enabling it.
6. **Route by type.** In the consumer, send .docx through the new extraction path, and keep everything else on `unsupported_format`.

Images (JPG, PNG) are a cheaper extension: Gemini reads them natively, so they need only a MIME type change in the request and their own eval fixtures.
