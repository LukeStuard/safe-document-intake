// Google Drive access for the queue consumer, under the drive.file scope:
// the app can only see and change files and folders it created itself.

export interface DriveEnv {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REFRESH_TOKEN: string;
}

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveFailure =
	| "token_rejected"
	| "token_unavailable"
	| "scope_mismatch"
	| "folder_rejected"
	| "folder_unavailable"
	| "upload_rejected"
	| "upload_unavailable"
	| "session_invalid"
	| "rename_rejected"
| 	  "rename_unavailable";

export class DriveError extends Error {
	constructor(
		readonly reason: DriveFailure,
		readonly retryable: boolean,
	) {
		super(reason);
		this.name = "DriveError";
	}
}

// Google signals rate limits as 429, or as 403 with a rateLimitExceeded-style reason.
async function isTransient(response: Response): Promise<boolean> {
	if (response.status === 429 || response.status >= 500) return true;
	if (response.status !== 403) return false;
	try {
		const body = (await response.clone().json()) as { error?: { errors?: { reason?: string }[] } };
		return (body.error?.errors ?? []).some((e) => /rateLimit/i.test(e.reason ?? ""));
	} catch {
		return false;
	}
}

async function send(fetchFn: typeof fetch, url: string, init: RequestInit, unavailable: DriveFailure): Promise<Response> {
	try {
		return await fetchFn(url, init);
	} catch {
		throw new DriveError(unavailable, true);
	}
}

async function check(response: Response, rejected: DriveFailure, unavailable: DriveFailure): Promise<void> {
	if (response.ok) return;
	if (await isTransient(response)) throw new DriveError(unavailable, true);
	throw new DriveError(rejected, false);
}

async function readId(response: Response, rejected: DriveFailure): Promise<string> {
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new DriveError(rejected, false);
	}
	const id = (data as { id?: unknown } | null)?.id;
	if (typeof id !== "string" || id === "") throw new DriveError(rejected, false);
	return id;
}

export async function getDriveToken(env: DriveEnv, fetchFn: typeof fetch = fetch): Promise<string> {
	// Built outside the request's try, so a missing setting surfaces as a bug.
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: env.GOOGLE_REFRESH_TOKEN.trim(),
		client_id: env.GOOGLE_CLIENT_ID.trim(),
		client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
	});

	const response = await send(
		fetchFn,
		TOKEN_URL,
		{ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
		"token_unavailable",
	);
	await check(response, "token_rejected", "token_unavailable");

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new DriveError("token_rejected", false);
	}
	const { access_token: token, scope } = (data ?? {}) as { access_token?: unknown; scope?: unknown };
	if (typeof token !== "string" || token === "") throw new DriveError("token_rejected", false);

	// Least privilege at runtime too: refuse a token that can do more than drive.file.
	const granted = typeof scope === "string" ? scope.split(" ").filter(Boolean) : [];
	if (granted.length !== 1 || granted[0] !== DRIVE_FILE_SCOPE) throw new DriveError("scope_mismatch", false);

	return token;
}

// parentId null puts the folder at the top of My Drive (used once, for the root folder).
export async function createFolder(
	token: string,
	name: string,
	parentId: string | null,
	fetchFn: typeof fetch = fetch,
): Promise<string> {
	const metadata = { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) };
	const response = await send(
		fetchFn,
		`${FILES_URL}?fields=id`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
			body: JSON.stringify(metadata),
		},
		"folder_unavailable",
	);
	await check(response, "folder_rejected", "folder_unavailable");
	return readId(response, "folder_rejected");
}

export interface UploadRequest {
	name: string;
	parentId: string;
	bytes: ArrayBuffer;
	contentType: string;
	// Private to this app. Record IDs only, so a Drive file can be traced back to its Salesforce source.
	appProperties: Record<string, string>;
}

// The session URL comes from Google's response, but the file's bytes go wherever it points,
// so only a Google upload URL is accepted.
function isGoogleUploadSession(location: string | null): location is string {
	if (!location) return false;
	try {
		const url = new URL(location);
		return url.protocol === "https:" && url.hostname === "www.googleapis.com" && url.pathname.startsWith("/upload/drive/v3/files");
	} catch {
		return false;
	}
}

// Resumable upload: one request to open the session, one to send the bytes.
export async function uploadFile(token: string, file: UploadRequest, fetchFn: typeof fetch = fetch): Promise<string> {
	const start = await send(
		fetchFn,
		`${UPLOAD_URL}?uploadType=resumable&fields=id`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=UTF-8",
				"X-Upload-Content-Type": file.contentType,
				"X-Upload-Content-Length": String(file.bytes.byteLength),
			},
			body: JSON.stringify({ name: file.name, parents: [file.parentId], appProperties: file.appProperties }),
		},
		"upload_unavailable",
	);
	await check(start, "upload_rejected", "upload_unavailable");

	const session = start.headers.get("Location");
	if (!isGoogleUploadSession(session)) throw new DriveError("session_invalid", false);

	const put = await send(
		fetchFn,
		session,
		{
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": file.contentType },
			body: file.bytes,
		},
		"upload_unavailable",
	);
	await check(put, "upload_rejected", "upload_unavailable");
	return readId(put, "upload_rejected");
}

// Renames a file the app created, which drive.file allows. Used to flag files filed before screening existed.
export async function renameFile(token: string, fileId: string, name: string, fetchFn: typeof fetch = fetch): Promise<void> {
	const response = await send(
		fetchFn,
		`${FILES_URL}/${encodeURIComponent(fileId)}?fields=id`,
		{
			method: "PATCH",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
			body: JSON.stringify({ name }),
		},
		"rename_unavailable",
	);
	await check(response, "rename_rejected", "rename_unavailable");
}