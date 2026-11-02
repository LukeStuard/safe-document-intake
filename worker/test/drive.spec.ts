import { describe, it, expect } from "vitest";
import { getDriveToken, createFolder, uploadFile, DriveError, DRIVE_FILE_SCOPE, type DriveEnv } from "../src/drive";

const ENV: DriveEnv = {
	GOOGLE_CLIENT_ID: "client-id\n",
	GOOGLE_CLIENT_SECRET: "client-secret\n",
	GOOGLE_REFRESH_TOKEN: "refresh-token\n",
};
const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc123";

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return respond(url, init);
	}) as typeof fetch;
	return { fn, calls };
}

async function failureOf(promise: Promise<unknown>): Promise<DriveError> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof DriveError) return e;
		throw e;
	}
	throw new Error("expected a DriveError");
}

const rateLimited = () => Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 });
const forbidden = () => Response.json({ error: { errors: [{ reason: "insufficientFilePermissions" }] } }, { status: 403 });

describe("getDriveToken", () => {
	it("exchanges the refresh token, trimmed, for an access token", async () => {
		const { fn, calls } = fakeFetch(() => Response.json({ access_token: "tok", scope: DRIVE_FILE_SCOPE }));
		expect(await getDriveToken(ENV, fn)).toBe("tok");

		expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
		const form = new URLSearchParams(String(calls[0].init?.body));
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("refresh-token");
		expect(form.get("client_id")).toBe("client-id");
		expect(form.get("client_secret")).toBe("client-secret");
	});

	it("refuses a token with more than drive.file", async () => {
		const { fn } = fakeFetch(() =>
			Response.json({ access_token: "tok", scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` }),
		);
		const err = await failureOf(getDriveToken(ENV, fn));
		expect(err.reason).toBe("scope_mismatch");
		expect(err.retryable).toBe(false);
	});

	it("refuses a token whose scope isn't stated", async () => {
		const { fn } = fakeFetch(() => Response.json({ access_token: "tok" }));
		expect((await failureOf(getDriveToken(ENV, fn))).reason).toBe("scope_mismatch");
	});

	it.each([
		[400, false, "token_rejected"],
		[401, false, "token_rejected"],
		[429, true, "token_unavailable"],
		[503, true, "token_unavailable"],
	])("HTTP %i: retryable %s (%s)", async (status, retryable, reason) => {
		const { fn } = fakeFetch(() => new Response("{}", { status }));
		const err = await failureOf(getDriveToken(ENV, fn));
		expect(err.retryable).toBe(retryable);
		expect(err.reason).toBe(reason);
	});
});

describe("createFolder", () => {
	it("creates a folder under its parent and returns the new ID", async () => {
		const { fn, calls } = fakeFetch(() => Response.json({ id: "folder-1" }));
		expect(await createFolder("tok", "2026", "parent-1", fn)).toBe("folder-1");

		expect(calls[0].url).toBe("https://www.googleapis.com/drive/v3/files?fields=id");
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer tok");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			name: "2026",
			mimeType: "application/vnd.google-apps.folder",
			parents: ["parent-1"],
		});
	});

	it("omits parents for the root folder", async () => {
		const { fn, calls } = fakeFetch(() => Response.json({ id: "root-1" }));
		await createFolder("tok", "Safe Document Intake", null, fn);
		expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty("parents");
	});

	it("retries Google's 403 rate limit, but not a real permission error", async () => {
		const limited = await failureOf(createFolder("tok", "x", "p", fakeFetch(rateLimited).fn));
		expect(limited.reason).toBe("folder_unavailable");
		expect(limited.retryable).toBe(true);

		const denied = await failureOf(createFolder("tok", "x", "p", fakeFetch(forbidden).fn));
		expect(denied.reason).toBe("folder_rejected");
		expect(denied.retryable).toBe(false);
	});
});

describe("uploadFile", () => {
	const FILE = {
		name: "Shah Rajvi Transcript #1.pdf",
		parentId: "student-folder",
		bytes: new TextEncoder().encode("%PDF-1.7 test").buffer as ArrayBuffer,
		contentType: "application/pdf",
		appProperties: { contentVersionId: "068000000000001AAA" },
	};

	it("opens a resumable session, then sends the bytes to it", async () => {
		const { fn, calls } = fakeFetch((url) =>
			url.includes("uploadType=resumable&fields=id")
				? new Response(null, { status: 200, headers: { Location: SESSION } })
				: Response.json({ id: "file-1" }),
		);

		expect(await uploadFile("tok", FILE, fn)).toBe("file-1");
		expect(calls).toHaveLength(2);

		const start = new Headers(calls[0].init?.headers);
		expect(calls[0].init?.method).toBe("POST");
		expect(start.get("X-Upload-Content-Type")).toBe("application/pdf");
		expect(start.get("X-Upload-Content-Length")).toBe(String(FILE.bytes.byteLength));
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			name: FILE.name,
			parents: ["student-folder"],
			appProperties: { contentVersionId: "068000000000001AAA" },
		});

		expect(calls[1].url).toBe(SESSION);
		expect(calls[1].init?.method).toBe("PUT");
		expect(calls[1].init?.body).toBe(FILE.bytes);
	});

	it.each([
		["another host", "https://evil.example/upload/drive/v3/files?upload_id=abc"],
		["plain http", "http://www.googleapis.com/upload/drive/v3/files?upload_id=abc"],
		["a non-upload path", "https://www.googleapis.com/drive/v3/files"],
		["no Location at all", null],
	])("refuses a session URL pointing at %s, and sends no bytes", async (_label, location) => {
		const { fn, calls } = fakeFetch(
			() => new Response(null, { status: 200, headers: location ? { Location: location } : {} }),
		);
		expect((await failureOf(uploadFile("tok", FILE, fn))).reason).toBe("session_invalid");
		expect(calls).toHaveLength(1);
	});

	it("retries when opening the session fails on Google's side", async () => {
		const { fn } = fakeFetch(() => new Response(null, { status: 500 }));
		const err = await failureOf(uploadFile("tok", FILE, fn));
		expect(err.reason).toBe("upload_unavailable");
		expect(err.retryable).toBe(true);
	});
});