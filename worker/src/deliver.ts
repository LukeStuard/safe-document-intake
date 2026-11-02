import { createFolder } from "./drive";
import { folderPath, ROOT_FOLDER, STAGE_FOLDER, type ItemDetails } from "./layout";
import { folderKey, getFolderId, saveFolderId } from "./store";

// Finds a folder by its key in D1, creating it in Drive only if it's never been made.
export async function ensureFolder(
	db: D1Database,
	key: string,
	name: string,
	parentId: string | null,
	token: string,
	fetchFn: typeof fetch,
	now: number,
): Promise<string> {
	const existing = await getFolderId(db, key);
	if (existing) return existing;
	const created = await createFolder(token, name, parentId, fetchFn);
	return saveFolderId(db, key, created, now);
}

// Root / Student-Admissions / year / term / "Last, First". Returns the student folder's ID.
// The student folder is keyed by application, so a name change can't split or merge folders.
export async function ensureStudentFolder(
	db: D1Database,
	item: ItemDetails,
	token: string,
	fetchFn: typeof fetch,
	now: number,
): Promise<string> {
	const [year, term, student] = folderPath(item);
	const root = await ensureFolder(db, folderKey.root(), ROOT_FOLDER, null, token, fetchFn, now);
	const stage = await ensureFolder(db, folderKey.stage(), STAGE_FOLDER, root, token, fetchFn, now);
	const yearId = await ensureFolder(db, folderKey.year(year), year, stage, token, fetchFn, now);
	const termId = await ensureFolder(db, folderKey.term(term), term, yearId, token, fetchFn, now);
	return ensureFolder(db, folderKey.application(item.applicationId), student, termId, token, fetchFn, now);
}