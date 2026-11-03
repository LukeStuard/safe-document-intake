import { describe, it, expect } from "vitest";
import { cleanName, yearOf, documentLabel, studentFolder, fileName, folderPath, LayoutError } from "../src/layout";

describe("cleanName", () => {
	it("strips characters Windows forbids and control characters", () => {
		expect(cleanName('a<b>c:d"e/f\\g|h?i*j\u0007k')).toBe("abcdefghijk");
	});

	it("collapses whitespace and trims", () => {
		expect(cleanName("  Shah,   Rajvi \n ")).toBe("Shah, Rajvi");
	});

	it("caps the length without leaving a trailing space", () => {
		expect(cleanName("abc def", 4)).toBe("abc");
	});
});

describe("yearOf", () => {
	it.each([
		["Fall 2026", "2026"],
		["Spring 2027", "2027"],
		["Spring II 2025", "2025"],
	])("%s -> %s", (term, year) => {
		expect(yearOf(term)).toBe(year);
	});

	it.each(["", "2026", "Fall", "Fall 26", "Fall 2026 extra"])("rejects %j", (term) => {
		expect(() => yearOf(term)).toThrow(LayoutError);
	});
});

describe("documentLabel", () => {
	it.each([
		["Transcript", "Transcript"],
		["Government_ID", "Government ID"],
		["Recommendation_Letter", "Recommendation Letter"],
	])("%s -> %s", (type, label) => {
		expect(documentLabel(type)).toBe(label);
	});

	it("rejects an empty type", () => {
		expect(() => documentLabel("")).toThrow(LayoutError);
	});
});

describe("studentFolder", () => {
	it("keeps the Last, First form", () => {
		expect(studentFolder("Shah, Rajvi")).toBe("Shah, Rajvi");
	});

	it.each(["", "   ", ","])("rejects a missing name (%j)", (name) => {
		expect(() => studentFolder(name)).toThrow(LayoutError);
	});

	it("can't be used to climb out of its folder", () => {
		expect(studentFolder("../../Other, Person")).toBe("....Other, Person");
	});
});

describe("fileName", () => {
	it("matches the original sync's pattern", () => {
		expect(fileName("Shah, Rajvi", "Transcript", 1, "pdf")).toBe("Shah Rajvi Transcript #1.pdf");
	});

	it("labels multi-word types and numbers repeats", () => {
		expect(fileName("De La Cruz, Mary Ann", "Government_ID", 2, "PDF")).toBe("De La Cruz Mary Ann Government ID #2.pdf");
	});

	it("falls back to pdf for an unusable extension", () => {
		expect(fileName("Shah, Rajvi", "Resume", 1, "../")).toBe("Shah Rajvi Resume #1.pdf");
	});
	it("marks a flagged file at the start of its name, numbering unchanged", () => {
		expect(fileName("Shah, Rajvi", "Transcript", 2, "pdf", true)).toBe("[FLAGGED] Shah Rajvi Transcript #2.pdf");
	});

	it("leaves an unflagged name exactly as before", () => {
		expect(fileName("Shah, Rajvi", "Transcript", 2, "pdf", false)).toBe("Shah Rajvi Transcript #2.pdf");
	});

	it("strips brackets from the name, so only the pipeline can produce the marker", () => {
		expect(fileName("[FLAGGED] Shah, Rajvi", "Transcript", 1, "pdf")).toBe("FLAGGED Shah Rajvi Transcript #1.pdf");
	});

	it("rejects a name that is nothing but brackets", () => {
		expect(() => fileName("[], []", "Transcript", 1, "pdf")).toThrow(LayoutError);
	});
});
	

describe("folderPath", () => {
	it("builds year, term, student", () => {
		expect(
			folderPath({ applicationId: "a00000000000001AAA", documentType: "Resume", term: "Fall 2026", folderName: "Shah, Rajvi" }),
		).toEqual(["2026", "Fall 2026", "Shah, Rajvi"]);
	});
});