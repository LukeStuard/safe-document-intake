// Folder and file names for the Drive layout, emulating the original SharePoint sync:
//   Safe Document Intake/Student-Admissions/<year>/<term>/<Last, First>/<Last First> <Doc Type> #n.pdf
// Names are for people browsing Drive. The Worker finds folders by ID (stored in D1), never by name.

export const ROOT_FOLDER = "Safe Document Intake";
export const STAGE_FOLDER = "Student-Admissions";

// What the Worker reads from Salesforce for one checklist item.
export interface ItemDetails {
	applicationId: string;
	documentType: string; // picklist value, e.g. "Government_ID"
	term: string; // e.g. "Fall 2026"
	folderName: string; // "Last, First", built by a formula in Salesforce
}

export class LayoutError extends Error {
	constructor(readonly reason: "term_unrecognized" | "folder_name_missing" | "document_type_missing") {
		super(reason);
		this.name = "LayoutError";
	}
}

// Drive allows almost any character, but people download these files to systems that don't.
// Drop control characters and the characters Windows forbids, collapse spaces, and cap the length.
export function cleanName(raw: string, maxLength = 120): string {
	return raw
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength)
		.trim();
}

// "Fall 2026" -> "2026". Terms always end in a four-digit year.
export function yearOf(term: string): string {
	const match = /^\S.*\s(\d{4})$/.exec(term.trim());
	if (!match) throw new LayoutError("term_unrecognized");
	return match[1];
}

// "Government_ID" -> "Government ID"
export function documentLabel(documentType: string): string {
	const label = cleanName(documentType.replace(/_/g, " "));
	if (!label) throw new LayoutError("document_type_missing");
	return label;
}

// "Shah, Rajvi" -> "Shah, Rajvi" (cleaned). The comma is kept for the folder, as in the original.
export function studentFolder(folderName: string): string {
	const name = cleanName(folderName);
	if (!name || name === ",") throw new LayoutError("folder_name_missing");
	return name;
}

// "Shah, Rajvi" + "Transcript" + 2 + "pdf" -> "Shah Rajvi Transcript #2.pdf"
export function fileName(folderName: string, documentType: string, sequence: number, extension: string): string {
	const person = studentFolder(folderName).replace(/,/g, "").replace(/\s+/g, " ");
	const ext = cleanName(extension).replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "pdf";
	return `${person} ${documentLabel(documentType)} #${sequence}.${ext}`;
}

// The folder levels under the stage folder, outermost first.
export function folderPath(item: ItemDetails): string[] {
	const term = cleanName(item.term);
	return [yearOf(term), term, studentFolder(item.folderName)];
}