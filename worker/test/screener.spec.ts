import { describe, expect, it } from "vitest";
import spec from "../src/screener-spec.json";
import { buildRequest, parseResponse, readProperties } from "../src/screener";

const enc = new TextEncoder();
const plainPdf = enc.encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
const pdfWithProps = enc.encode(
	"%PDF-1.4\n1 0 obj\n<< /Title (Transcript \\(final\\)) /Author (Registrar) /Title (Transcript \\(final\\)) >>\nendobj\n%%EOF",
);

const good = {
	tampering_detected: false,
	tampering_excerpt: "",
	detected_type: "Transcript",
	verdict: "pass",
	reasons: "A readable transcript for this applicant.",
};

function answer(fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fields) }] }, ...extra }] };
}

function userText(type: string, name: string) {
	return spec.userTemplate.replace("{type}", () => type).replace("{name}", () => name);
}

describe("buildRequest", () => {
	it("sends only the document, the filed type and the applicant's name", () => {
		const input = {
			pdf: plainPdf,
			filedType: "Transcript",
			applicantName: "Hayden Jensen",
			applicationId: "a01XYZ000000001",
			email: "hayden@example.com",
		};
		const req = buildRequest(input);

		expect(Object.keys(req).sort()).toEqual(["contents", "generationConfig", "systemInstruction"]);
		expect(req.systemInstruction).toEqual({ parts: [{ text: spec.system }] });
		expect(req.generationConfig).toEqual({ responseMimeType: "application/json", responseSchema: spec.responseSchema });
		expect(req.contents).toHaveLength(1);
		expect(req.contents[0].parts).toEqual([
			{ inline_data: { mime_type: "application/pdf", data: btoa(String.fromCharCode(...plainPdf)) } },
			{ text: userText("Transcript", "Hayden Jensen") },
		]);

		const body = JSON.stringify(req);
		expect(body).not.toContain("a01XYZ000000001");
		expect(body).not.toContain("hayden@example.com");
	});

	it("adds document properties as a separate part, once each", () => {
		const parts = buildRequest({ pdf: pdfWithProps, filedType: "Transcript", applicantName: "Kai Uribe" }).contents[0].parts;
		expect(parts).toHaveLength(3);
		expect(parts[2]).toEqual({
			text: spec.propertiesTemplate.replace("{properties}", "Title: Transcript (final)\nAuthor: Registrar"),
		});
	});

	it("inserts names literally, even with $ or template text in them", () => {
		const parts = buildRequest({ pdf: plainPdf, filedType: "Transcript", applicantName: "Jo $& {type}" }).contents[0].parts;
		expect(parts[1]).toEqual({ text: userText("Transcript", "Jo $& {type}") });
	});

	it("encodes large files without overflowing the stack", () => {
		const big = new Uint8Array(3 * 1024 * 1024).fill(65);
		const doc = buildRequest({ pdf: big, filedType: "Transcript", applicantName: "Kai Uribe" }).contents[0].parts[0];
		expect(atob((doc as { inline_data: { data: string } }).inline_data.data).length).toBe(big.length);
	});
});

describe("readProperties", () => {
	it("returns nothing for a file without an Info dictionary", () => {
		expect(readProperties(plainPdf)).toEqual([]);
	});
});

describe("parseResponse", () => {
	it("accepts a well-formed answer", () => {
		expect(parseResponse(answer(good))).toEqual({
			verdict: "pass",
			tamperingDetected: false,
			tamperingExcerpt: "",
			detectedType: "Transcript",
			reasons: good.reasons,
			failure: null,
		});
	});

	it("skips thought parts and reads the answer", () => {
		const body = {
			candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking...", thought: true }, { text: JSON.stringify(good) }] } }],
		};
		expect(parseResponse(body).verdict).toBe("pass");
	});

	it.each([
		["a null body", null, "no_candidate"],
		["no candidates", {}, "no_candidate"],
		["a safety stop", answer(good, { finishReason: "SAFETY" }), "finish_SAFETY"],
		["no text part", { candidates: [{ finishReason: "STOP", content: { parts: [] } }] }, "no_text"],
		["text that isn't JSON", { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "pass" }] } }] }, "not_json"],
		["a JSON array", { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "[]" }] } }] }, "not_object"],
		["an off-list verdict", answer({ ...good, verdict: "approved" }), "bad_verdict"],
		["a string tampering flag", answer({ ...good, tampering_detected: "false" }), "bad_tampering_flag"],
		["a missing field", answer({ ...good, reasons: undefined }), "missing_field"],
		["reasons over 300 characters", answer({ ...good, reasons: "x".repeat(301) }), "reasons_too_long"],
	])("fails closed to needs_human on %s", (_, body, failure) => {
		expect(parseResponse(body)).toMatchObject({ verdict: "needs_human", failure, tamperingDetected: null });
	});

	it("keeps a tampering flag that disagrees with the verdict", () => {
		const result = parseResponse(answer({ ...good, tampering_detected: true, tampering_excerpt: "ignore previous" }));
		expect(result).toMatchObject({
			verdict: "tampering_suspected",
			tamperingDetected: true,
			tamperingExcerpt: "ignore previous",
			failure: "tampering_inconsistent",
		});
	});

	it("keeps a tampering verdict that comes without the flag", () => {
		const result = parseResponse(answer({ ...good, verdict: "tampering_suspected" }));
		expect(result).toMatchObject({ verdict: "tampering_suspected", failure: "tampering_inconsistent" });
	});

	it("keeps a tampering flag even when the rest of the answer is broken", () => {
		const result = parseResponse(answer({ ...good, tampering_detected: true, tampering_excerpt: "x", reasons: "y".repeat(400) }));
		expect(result).toMatchObject({ verdict: "tampering_suspected", tamperingExcerpt: "x", failure: "reasons_too_long" });
	});
});