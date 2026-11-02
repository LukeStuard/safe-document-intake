import { describe, it, expect } from "vitest";
import { parseJob } from "../src/jobs";

const GOOD = {
	v: 1,
	contentVersionId: "068000000000001AAA",
	checklistItemId: "a01000000000001AAA",
	acceptedAt: 1767225600,
};

describe("parseJob", () => {
	it("accepts a well-formed job", () => {
		expect(parseJob(GOOD)).toEqual(GOOD);
	});

	it("accepts 15-character Salesforce IDs", () => {
		const job = { ...GOOD, contentVersionId: "068000000000001", checklistItemId: "a01000000000001" };
		expect(parseJob(job)).toEqual(job);
	});

	it("drops extra fields, so nothing unexpected travels down the pipeline", () => {
		expect(parseJob({ ...GOOD, applicantName: "Jane Doe" })).toEqual(GOOD);
	});

	it.each([
		["null", null],
		["a string", "068000000000001AAA"],
		["an unknown version", { ...GOOD, v: 2 }],
		["a missing ID", { ...GOOD, checklistItemId: undefined }],
		["a 14-character ID", { ...GOOD, contentVersionId: "06800000000000" }],
		["an ID with punctuation", { ...GOOD, contentVersionId: "068000000000001AA'" }],
		["a fractional timestamp", { ...GOOD, acceptedAt: 1767225600.5 }],
	])("rejects %s", (_label, body) => {
		expect(parseJob(body)).toBeNull();
	});
});