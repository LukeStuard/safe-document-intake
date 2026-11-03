// Salesforce access for the queue consumer, as the intake pipeline user.
// Never logs or returns tokens, and only ever fetches the one file it's asked for.
import type { ItemDetails } from "./layout";
export interface SalesforceEnv {
	SF_INSTANCE_URL: string;
	SF_CLIENT_ID: string;
	SF_CLIENT_SECRET: string;
	SF_API_VERSION: string;
}

// Well above any real admissions document, well below the Worker's memory limit.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type SalesforceFailure =
	| "token_rejected"
	| "token_unavailable"
	| "file_not_found"
	| "file_too_large"
	| "download_rejected"
	| "download_unavailable"
	| "item_not_found"
	| "details_rejected"
	| "details_unavailable";

// `retryable` decides between a queue retry (Salesforce is having a moment) and giving up (retrying can't help).
export class SalesforceError extends Error {
	constructor(
		readonly reason: SalesforceFailure,
		readonly retryable: boolean,
	) {
		super(reason);
		this.name = "SalesforceError";
	}
}

const isTransient = (status: number) => status === 429 || status >= 500;

function baseUrl(env: SalesforceEnv): string {
	return env.SF_INSTANCE_URL.trim().replace(/\/+$/, "");
}
// Salesforce answers 404 for a malformed version too, which would look exactly like a missing file.
// Checked before any request, so a bad setting surfaces as a bug instead.
function apiVersion(env: SalesforceEnv): string {
	const version = env.SF_API_VERSION.trim();
	if (!/^\d+\.0$/.test(version)) throw new TypeError("SF_API_VERSION must look like 68.0");
	return version;
}

export async function getAccessToken(env: SalesforceEnv, fetchFn: typeof fetch = fetch): Promise<string> {
		// Built outside the try, so a missing setting surfaces as a bug, not as "Salesforce unavailable".
	const url = `${baseUrl(env)}/services/oauth2/token`;
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: env.SF_CLIENT_ID.trim(),
		client_secret: env.SF_CLIENT_SECRET.trim(),
	});

	let response: Response;
	try {
		response = await fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
	} catch {
		throw new SalesforceError("token_unavailable", true);
	}

	if (isTransient(response.status)) throw new SalesforceError("token_unavailable", true);
	if (!response.ok) throw new SalesforceError("token_rejected", false);

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new SalesforceError("token_rejected", false);
	}
	const token = (data as { access_token?: unknown } | null)?.access_token;
	if (typeof token !== "string" || token === "") throw new SalesforceError("token_rejected", false);
	return token;
}

export interface DownloadedFile {
	bytes: ArrayBuffer;
	contentType: string;
}

// The ID has already passed parseJob (alphanumeric only), so it's safe in the path.
export async function downloadVersion(
	env: SalesforceEnv,
	token: string,
	contentVersionId: string,
	fetchFn: typeof fetch = fetch,
): Promise<DownloadedFile> {
		const url = `${baseUrl(env)}/services/data/v${apiVersion(env)}/sobjects/ContentVersion/${contentVersionId}/VersionData`;

	let response: Response;
	try {
		response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
	} catch {
		throw new SalesforceError("download_unavailable", true);
	}

	// 404 also covers "exists but the pipeline can't see it", as the access probe showed.
	if (response.status === 404) throw new SalesforceError("file_not_found", false);
	if (isTransient(response.status)) throw new SalesforceError("download_unavailable", true);
	if (!response.ok) throw new SalesforceError("download_rejected", false);

	// Refuse oversize files before reading them, when Salesforce says the size up front.
	const declared = Number(response.headers.get("Content-Length") ?? "0");
	if (declared > MAX_FILE_BYTES) {
		await response.body?.cancel();
		throw new SalesforceError("file_too_large", false);
	}

	const bytes = await response.arrayBuffer();
	if (bytes.byteLength > MAX_FILE_BYTES) throw new SalesforceError("file_too_large", false);

	return { bytes, contentType: response.headers.get("Content-Type") ?? "application/octet-stream" };
}
export interface JobDetails {
	item: ItemDetails;
	fileExtension: string;
}

async function getJson(fetchFn: typeof fetch, url: string, token: string, notFound: SalesforceFailure): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
	} catch {
		throw new SalesforceError("details_unavailable", true);
	}
	if (response.status === 404) throw new SalesforceError(notFound, false);
	if (isTransient(response.status)) throw new SalesforceError("details_unavailable", true);
	if (!response.ok) throw new SalesforceError("details_rejected", false);
	try {
		return await response.json();
	} catch {
		throw new SalesforceError("details_rejected", false);
	}
}

// What naming needs: the checklist item's type, its application's term and folder name, and the file's extension.
// Both IDs have passed parseJob (alphanumeric only), so they're safe in a query and a path.
export async function getJobDetails(
	env: SalesforceEnv,
	token: string,
	job: { contentVersionId: string; checklistItemId: string },
	fetchFn: typeof fetch = fetch,
): Promise<JobDetails> {
	const base = `${baseUrl(env)}/services/data/v${apiVersion(env)}`;
	const soql =
		"SELECT Document_Type__c, Application__c, Application__r.Term__c, Application__r.Applicant_Folder_Name__c " +
		`FROM Checklist_Item__c WHERE Id = '${job.checklistItemId}'`;

	const result = (await getJson(fetchFn, `${base}/query?q=${encodeURIComponent(soql)}`, token, "item_not_found")) as {
		records?: {
			Document_Type__c?: unknown;
			Application__c?: unknown;
			Application__r?: { Term__c?: unknown; Applicant_Folder_Name__c?: unknown } | null;
		}[];
	};
	const record = result.records?.[0];
	if (!record || typeof record.Application__c !== "string" || record.Application__c === "") {
		throw new SalesforceError("item_not_found", false);
	}

	const meta = (await getJson(
		fetchFn,
		`${base}/sobjects/ContentVersion/${job.contentVersionId}?fields=FileExtension`,
		token,
		"file_not_found",
	)) as { FileExtension?: unknown };

	// Blanks pass through as empty strings; the naming rules reject them as data problems.
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	return {
		item: {
			applicationId: record.Application__c,
			documentType: text(record.Document_Type__c),
			term: text(record.Application__r?.Term__c),
			folderName: text(record.Application__r?.Applicant_Folder_Name__c),
		},
		fileExtension: text(meta.FileExtension),
	};
}

export interface VersionRef {
	contentVersionId: string;
	checklistItemId: string;
}

// Every checklist item's attached files, latest version only. The reconciler's view of what should be in Drive.
export async function listLatestVersions(env: SalesforceEnv, token: string, fetchFn: typeof fetch = fetch): Promise<VersionRef[]> {
	const base = baseUrl(env);
	const soql = "SELECT Id, (SELECT ContentDocument.LatestPublishedVersionId FROM ContentDocumentLinks) FROM Checklist_Item__c";
	let path = `/services/data/v${apiVersion(env)}/query?q=${encodeURIComponent(soql)}`;
	const refs: VersionRef[] = [];

	for (let page = 0; page < 50; page++) {
		const result = (await getJson(fetchFn, `${base}${path}`, token, "details_rejected")) as {
			records?: { Id?: unknown; ContentDocumentLinks?: { records?: { ContentDocument?: { LatestPublishedVersionId?: unknown } }[] } | null }[];
			nextRecordsUrl?: unknown;
		};
		for (const item of result.records ?? []) {
			for (const link of item.ContentDocumentLinks?.records ?? []) {
				const cv = link.ContentDocument?.LatestPublishedVersionId;
				if (typeof item.Id === "string" && typeof cv === "string") refs.push({ contentVersionId: cv, checklistItemId: item.Id });
			}
		}

		const next = result.nextRecordsUrl;
		if (next === undefined || next === null) return refs;
		// The token goes wherever this points, so only a query path on the same org is followed.
		if (typeof next !== "string" || !/^\/services\/data\/v\d+\.0\/query\/[A-Za-z0-9-]+$/.test(next)) {
			throw new SalesforceError("details_rejected", false);
		}
		path = next;
	}
	// More than 50 pages means something is wrong, not that the org is big.
	throw new SalesforceError("details_rejected", false);
}