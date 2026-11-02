import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { folderKey, getFolderId, saveFolderId, findUpload, nextSequence, recordUpload } from "../src/store";

const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;
const NOW = 1767225600;

const upload = (contentVersionId: string, applicationId: string, documentType: string, sequence: number) => ({
	contentVersionId,
	applicationId,
	documentType,
	sequence,
	driveFileId: `drive-${contentVersionId}`,
});

describe("folder records", () => {
	it("returns null for a folder that was never created", async () => {
		expect(await getFolderId(db, folderKey.term("Never 1999"))).toBeNull();
	});

	it("stores and reads back a folder ID", async () => {
		const key = folderKey.application("a00000000000001AAA");
		expect(await saveFolderId(db, key, "folder-1", NOW)).toBe("folder-1");
		expect(await getFolderId(db, key)).toBe("folder-1");
	});

	it("keeps the first folder ID if a second one is saved for the same key", async () => {
		const key = folderKey.year("2031");
		await saveFolderId(db, key, "first", NOW);
		expect(await saveFolderId(db, key, "second", NOW)).toBe("first");
		expect(await getFolderId(db, key)).toBe("first");
	});
});

describe("upload records", () => {
	it("finds an upload by ContentVersion only after it's recorded", async () => {
		expect(await findUpload(db, "068000000000011AAA")).toBeNull();
		await recordUpload(db, upload("068000000000011AAA", "a00000000000011AAA", "Transcript", 1), NOW);
		expect(await findUpload(db, "068000000000011AAA")).toEqual(upload("068000000000011AAA", "a00000000000011AAA", "Transcript", 1));
	});

	it("numbers per application and document type", async () => {
		const app = "a00000000000012AAA";
		expect(await nextSequence(db, app, "Transcript")).toBe(1);
		await recordUpload(db, upload("068000000000012AAA", app, "Transcript", 1), NOW);
		await recordUpload(db, upload("068000000000013AAA", app, "Transcript", 2), NOW);

		expect(await nextSequence(db, app, "Transcript")).toBe(3);
		expect(await nextSequence(db, app, "Resume")).toBe(1);
		expect(await nextSequence(db, "a00000000000099AAA", "Transcript")).toBe(1);
	});

	it("refuses to record the same ContentVersion twice", async () => {
		const record = upload("068000000000014AAA", "a00000000000014AAA", "Resume", 1);
		await recordUpload(db, record, NOW);
		await expect(recordUpload(db, record, NOW)).rejects.toThrow();
	});
});