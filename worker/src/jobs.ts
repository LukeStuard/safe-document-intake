// The message the webhook puts on the intake queue. Record IDs only:
// no names, file contents or anything else about the applicant.
export interface IntakeJob {
	v: 1; // Message format version, so old messages are recognizable if the shape changes.
	contentVersionId: string;
	checklistItemId: string;
	acceptedAt: number; // Unix seconds when the webhook accepted the request.
}
// Salesforce IDs: 15 or 18 alphanumeric characters.
const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

// Returns a clean job, or null if the message isn't one. Building a new object
// drops any extra fields, so nothing unexpected travels further down the pipeline.
export function parseJob(body: unknown): IntakeJob | null {
	if (typeof body !== "object" || body === null) return null;
	const b = body as Record<string, unknown>;
	if (b.v !== 1) return null;
	if (typeof b.contentVersionId !== "string" || !SF_ID.test(b.contentVersionId)) return null;
	if (typeof b.checklistItemId !== "string" || !SF_ID.test(b.checklistItemId)) return null;
	if (typeof b.acceptedAt !== "number" || !Number.isInteger(b.acceptedAt)) return null;
	return { v: 1, contentVersionId: b.contentVersionId, checklistItemId: b.checklistItemId, acceptedAt: b.acceptedAt };
}