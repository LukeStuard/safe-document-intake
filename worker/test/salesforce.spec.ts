import { describe, it, expect } from 'vitest';
import { getAccessToken, downloadVersion, SalesforceError, MAX_FILE_BYTES, type SalesforceEnv } from '../src/salesforce';

const ENV: SalesforceEnv = {
	SF_INSTANCE_URL: 'https://example.my.salesforce.com/\n',
	SF_CLIENT_ID: 'client-id\n',
	SF_CLIENT_SECRET: 'client-secret\n',
	SF_API_VERSION: '68.0',
};
const CV = '068000000000001AAA';

// Records each request and answers with a canned response.
function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return respond(url, init);
	}) as typeof fetch;
	return { fn, calls };
}

async function failureOf(promise: Promise<unknown>): Promise<SalesforceError> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof SalesforceError) return e;
		throw e;
	}
	throw new Error('expected a SalesforceError');
}

describe('getAccessToken', () => {
	it("posts client credentials, trimmed, to the org's token endpoint", async () => {
		const { fn, calls } = fakeFetch(() => Response.json({ access_token: 'tok' }));
		expect(await getAccessToken(ENV, fn)).toBe('tok');

		expect(calls[0].url).toBe('https://example.my.salesforce.com/services/oauth2/token');
		const form = new URLSearchParams(String(calls[0].init?.body));
		expect(form.get('grant_type')).toBe('client_credentials');
		expect(form.get('client_id')).toBe('client-id');
		expect(form.get('client_secret')).toBe('client-secret');
	});

	it.each([
		[400, false, 'token_rejected'],
		[401, false, 'token_rejected'],
		[429, true, 'token_unavailable'],
		[503, true, 'token_unavailable'],
	])('HTTP %i: retryable %s (%s)', async (status, retryable, reason) => {
		const { fn } = fakeFetch(() => new Response('{}', { status }));
		const err = await failureOf(getAccessToken(ENV, fn));
		expect(err.retryable).toBe(retryable);
		expect(err.reason).toBe(reason);
	});

	it('treats a network failure as retryable', async () => {
		const { fn } = fakeFetch(() => {
			throw new TypeError('network down');
		});
		expect((await failureOf(getAccessToken(ENV, fn))).reason).toBe('token_unavailable');
	});

	it('rejects a 200 with no token in it', async () => {
		const { fn } = fakeFetch(() => Response.json({ access_token: '' }));
		expect((await failureOf(getAccessToken(ENV, fn))).reason).toBe('token_rejected');
	});
});

describe('downloadVersion', () => {
	it('fetches exactly the requested version with the bearer token', async () => {
		const pdf = new TextEncoder().encode('%PDF-1.7 test');
		const { fn, calls } = fakeFetch(() => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }));

		const file = await downloadVersion(ENV, 'tok', CV, fn);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`https://example.my.salesforce.com/services/data/v68.0/sobjects/ContentVersion/${CV}/VersionData`);
		expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer tok');
		expect(new Uint8Array(file.bytes)).toEqual(pdf);
		expect(file.contentType).toBe('application/pdf');
	});

	it.each([
		[404, false, 'file_not_found'],
		[403, false, 'download_rejected'],
		[429, true, 'download_unavailable'],
		[500, true, 'download_unavailable'],
	])('HTTP %i: retryable %s (%s)', async (status, retryable, reason) => {
		const { fn } = fakeFetch(() => new Response(null, { status }));
		const err = await failureOf(downloadVersion(ENV, 'tok', CV, fn));
		expect(err.retryable).toBe(retryable);
		expect(err.reason).toBe(reason);
	});

	it('refuses an oversize file from its declared length, before reading it', async () => {
		const { fn } = fakeFetch(() => new Response('small body', { headers: { 'Content-Length': String(MAX_FILE_BYTES + 1) } }));
		expect((await failureOf(downloadVersion(ENV, 'tok', CV, fn))).reason).toBe('file_too_large');
	});

	it("refuses an oversize file that didn't declare its length", async () => {
		const { fn } = fakeFetch(() => new Response(new Uint8Array(MAX_FILE_BYTES + 1)));
		expect((await failureOf(downloadVersion(ENV, 'tok', CV, fn))).reason).toBe('file_too_large');
	});
    	it.each(["68", "v68.0", "68.1", ""])("refuses a malformed API version (%j) before making any request", async (version) => {
		const { fn, calls } = fakeFetch(() => new Response(null, { status: 404 }));
		await expect(downloadVersion({ ...ENV, SF_API_VERSION: version }, "tok", CV, fn)).rejects.toThrow(TypeError);
		expect(calls).toHaveLength(0);
	});
    
});
