// D1 records for the Drive side: which folders exist, and which files were uploaded.

export const folderKey = {
	root: () => "root",
	stage: () => "stage",
	year: (year: string) => `year:${year}`,
	term: (term: string) => `term:${term}`,
	application: (applicationId: string) => `application:${applicationId}`,
};

export async function getFolderId(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare("SELECT folder_id FROM drive_folders WHERE folder_key = ?").bind(key).first<{ folder_id: string }>();
	return row?.folder_id ?? null;
}

// Returns the ID that ends up stored. If a record already exists, it wins, and the caller's
// new folder is left unused in Drive (only possible if two runs race, which concurrency 1 prevents).
export async function saveFolderId(db: D1Database, key: string, folderId: string, now: number): Promise<string> {
	await db
		.prepare("INSERT INTO drive_folders (folder_key, folder_id, created_at) VALUES (?, ?, ?) ON CONFLICT (folder_key) DO NOTHING")
		.bind(key, folderId, now)
		.run();
	const stored = await getFolderId(db, key);
	if (!stored) throw new Error("folder record missing after insert");
	return stored;
}

export interface UploadRecord {
	contentVersionId: string;
	applicationId: string;
	documentType: string;
	sequence: number;
	driveFileId: string;
}

export async function findUpload(db: D1Database, contentVersionId: string): Promise<UploadRecord | null> {
	const row = await db
		.prepare(
			"SELECT content_version_id, application_id, document_type, sequence, drive_file_id FROM drive_uploads WHERE content_version_id = ?",
		)
		.bind(contentVersionId)
		.first<{ content_version_id: string; application_id: string; document_type: string; sequence: number; drive_file_id: string }>();
	if (!row) return null;
	return {
		contentVersionId: row.content_version_id,
		applicationId: row.application_id,
		documentType: row.document_type,
		sequence: row.sequence,
		driveFileId: row.drive_file_id,
	};
}

// The next "#n" for this application and document type: one past the highest used so far.
export async function nextSequence(db: D1Database, applicationId: string, documentType: string): Promise<number> {
	const row = await db
		.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM drive_uploads WHERE application_id = ? AND document_type = ?")
		.bind(applicationId, documentType)
		.first<{ next: number }>();
	return row?.next ?? 1;
}

// A plain insert on purpose: recording the same ContentVersion twice is a bug, and should throw.
export async function recordUpload(db: D1Database, record: UploadRecord, now: number): Promise<void> {
	await db
		.prepare(
			"INSERT INTO drive_uploads (content_version_id, application_id, document_type, sequence, drive_file_id, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(record.contentVersionId, record.applicationId, record.documentType, record.sequence, record.driveFileId, now)
		.run();
}