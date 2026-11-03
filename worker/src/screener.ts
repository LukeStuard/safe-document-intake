// Builds the Gemini screening request and turns its answer into a verdict the pipeline can trust.
// The request carries only the document, the filed type and the applicant's name.
// Anything unexpected in the answer fails closed; nothing here ever throws.
import spec from "./screener-spec.json";

export type Verdict = "pass" | "wrong_type" | "name_mismatch" | "illegible" | "tampering_suspected" | "needs_human";

const VERDICTS: readonly string[] = spec.responseSchema.properties.verdict.enum;
const MAX_REASONS = 300;
const PROPERTY_PATTERN = /\/(Title|Subject|Keywords|Author|Creator|Producer)\s*\(((?:\\.|[^\\)])*)\)/g;

export interface ScreenInput {
	pdf: Uint8Array;
	filedType: string;
	applicantName: string;
}

export interface ScreenResult {
	verdict: Verdict;
	tamperingDetected: boolean | null;
	tamperingExcerpt: string | null;
	detectedType: string | null;
	reasons: string | null;
	failure: string | null; // why the answer was rejected, or null when it was accepted
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any; // model output is untrusted until every field is checked below

// Bytes to a string with one char per byte (Latin-1). Chunked so large files don't overflow the call stack.
function bytesToBinary(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return out;
}

// Document properties never reach the model as page content, so they're read out and passed explicitly.
// Only literal strings in the uncompressed Info dictionary are seen; properties in compressed streams are not.
export function readProperties(pdf: Uint8Array): string[] {
	const found = new Set<string>();
	for (const m of bytesToBinary(pdf).matchAll(PROPERTY_PATTERN)) {
		found.add(`${m[1]}: ${m[2].replace(/\\(.)/g, "$1")}`);
	}
	return [...found];
}

// Destructured on purpose: whatever else the caller's object holds can't reach the payload.
export function buildRequest({ pdf, filedType, applicantName }: ScreenInput) {
	// One pass with a function replacement, so a "$" or "{type}" inside a name is inserted as-is.
	const user = spec.userTemplate.replace(/\{(type|name)\}/g, (_, key: string) => (key === "type" ? filedType : applicantName));
	const parts: Array<Record<string, unknown>> = [
		{ inline_data: { mime_type: "application/pdf", data: btoa(bytesToBinary(pdf)) } },
		{ text: user },
	];
	const props = readProperties(pdf);
	if (props.length > 0) {
		parts.push({ text: spec.propertiesTemplate.replace("{properties}", () => props.join("\n")) });
	}
	return {
		systemInstruction: { parts: [{ text: spec.system }] },
		contents: [{ role: "user", parts }],
		generationConfig: { responseMimeType: "application/json", responseSchema: spec.responseSchema },
	};
}

function rejected(failure: string, out?: Loose): ScreenResult {
	// A tampering signal survives a rejected answer, so the document still reaches a reviewer marked as suspect.
	const flagged = out?.tampering_detected === true || out?.verdict === "tampering_suspected";
	return {
		verdict: flagged ? "tampering_suspected" : "needs_human",
		tamperingDetected: flagged ? true : null,
		tamperingExcerpt: flagged && typeof out?.tampering_excerpt === "string" ? out.tampering_excerpt : null,
		detectedType: null,
		reasons: null,
		failure,
	};
}

export function parseResponse(body: unknown): ScreenResult {
	const candidate = (body as Loose)?.candidates?.[0];
	if (!candidate) return rejected("no_candidate");
	if (candidate.finishReason && candidate.finishReason !== "STOP") return rejected(`finish_${candidate.finishReason}`);

	// Thinking models can return thought parts; the answer is the first non-thought text part.
	const parts = candidate.content?.parts;
	const text = Array.isArray(parts) ? parts.find((p: Loose) => typeof p?.text === "string" && !p.thought)?.text : undefined;
	if (typeof text !== "string") return rejected("no_text");

	let out: Loose;
	try {
		out = JSON.parse(text);
	} catch {
		return rejected("not_json");
	}
	if (out === null || typeof out !== "object" || Array.isArray(out)) return rejected("not_object");

	const { verdict, tampering_detected, tampering_excerpt, detected_type, reasons } = out;
	if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) return rejected("bad_verdict", out);
	if (typeof tampering_detected !== "boolean") return rejected("bad_tampering_flag", out);
	if (typeof tampering_excerpt !== "string" || typeof detected_type !== "string" || typeof reasons !== "string") {
		return rejected("missing_field", out);
	}
	if (reasons.length > MAX_REASONS) return rejected("reasons_too_long", out);
	// Tampering outranks every other verdict, so the flag and the verdict must agree.
	if (tampering_detected !== (verdict === "tampering_suspected")) return rejected("tampering_inconsistent", out);

	return {
		verdict: verdict as Verdict,
		tamperingDetected: tampering_detected,
		tamperingExcerpt: tampering_excerpt,
		detectedType: detected_type,
		reasons,
		failure: null,
	};
}