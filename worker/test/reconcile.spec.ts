import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { reconcile, MAX_PER_RUN, STAGGER_SECONDS, type ReconcileEnv } from '../src/reconcile';
import { SalesforceError } from '../src/salesforce';
import { recordUpload } from '../src/store';
import { audit } from '../src/audit';

const db = (env as unknown as { AUDIT_DB: D1Database }).AUDIT_DB;

// A finished file: its screening row is in the audit log.
const markScreened = (ref: { cv: string; item: string }) =>
	audit(db, { contentVersionId: ref.cv, checklistItemId: ref.item, stage: 'screen', event: 'screened', reason: 'pass', attempt: 1 });

let counter = 500;
function newRef() {
	counter++;
	const n = String(counter).padStart(12, '0');
	return { cv: `068${n}AAA`, item: `a01${n}AAA` };
}

function captureQueue() {
	const sent: Record<string, unknown>[] = [];
	const delays: (number | undefined)[] = [];
	let calls = 0;
	const queue = {
		async send() {
			throw new Error('the reconciler only uses sendBatch');
		},
		async sendBatch(messages: { body: Record<string, unknown>; delaySeconds?: number }[]) {
			calls++;
			sent.push(...messages.map((m) => m.body));
			delays.push(...messages.map((m) => m.delaySeconds));
		},
	} as unknown as Queue;
	return { queue, sent, delays, calls: () => calls };
}

type Page = { items: { item: string; cvs: string[] }[]; next?: string };

// A fake Salesforce: a token, then one response per query page.
function salesforce(pages: Page[]) {
	const urls: string[] = [];
	let page = 0;
	const fetchFn = (async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith('/services/oauth2/token')) return Response.json({ access_token: 'tok' });
		const p = pages[page++];
		return Response.json({
			records: p.items.map((i) => ({
				Id: i.item,
				ContentDocumentLinks: i.cvs.length ? { records: i.cvs.map((cv) => ({ ContentDocument: { LatestPublishedVersionId: cv } })) } : null,
			})),
			...(p.next ? { nextRecordsUrl: p.next } : {}),
		});
	}) as typeof fetch;
	return { fetchFn, urls };
}

const envWith = (queue: Queue) =>
	({
		SF_INSTANCE_URL: 'https://example.my.salesforce.com',
		SF_CLIENT_ID: 'id',
		SF_CLIENT_SECRET: 'secret',
		SF_API_VERSION: '68.0',
		AUDIT_DB: db,
		INTAKE_QUEUE: queue,
	}) as ReconcileEnv;

// One reconcile run against a fake queue and a fake Salesforce.
const run = (q: ReturnType<typeof captureQueue>, sf: ReturnType<typeof salesforce>) => reconcile(envWith(q.queue), { fetch: sf.fetchFn });

describe('reconciler', () => {
	it("queues only files that aren't in Drive yet, and records why", async () => {
		const done = newRef();
		const missing = newRef();
		const empty = newRef();
		await recordUpload(
			db,
			{ contentVersionId: done.cv, applicationId: 'a00000000000500AAA', documentType: 'Resume', sequence: 1, driveFileId: 'f' },
			1,
		);
		await markScreened(done);
		const q = captureQueue();
		const sf = salesforce([
			{
				items: [
					{ item: done.item, cvs: [done.cv] },
					{ item: missing.item, cvs: [missing.cv] },
					{ item: empty.item, cvs: [] },
				],
			},
		]);

		const result = await run(q, sf);

		expect(q.sent.map((b) => b.contentVersionId)).toEqual([missing.cv]);
		expect(result).toMatchObject({ found: 2, alreadyUploaded: 1, queued: 1, deferred: 0 });
		const row = await db.prepare('SELECT event, reason FROM audit_log WHERE content_version_id = ?').bind(missing.cv).first();
		expect(row).toEqual({ event: 'queued', reason: 'reconciler' });
	});

	it('leaves given-up files for a person to fix', async () => {
		const bad = newRef();
		await audit(db, {
			contentVersionId: bad.cv,
			checklistItemId: bad.item,
			event: 'failed',
			reason: 'term_unrecognized',
			attempt: 1,
			final: true,
		});
		const q = captureQueue();

		const result = await run(q, salesforce([{ items: [{ item: bad.item, cvs: [bad.cv] }] }]));

		expect(q.sent).toHaveLength(0);
		expect(result.givenUp).toBe(1);
	});

	it("follows Salesforce's next-page links", async () => {
		const a = newRef();
		const b = newRef();
		const next = '/services/data/v68.0/query/01gXYZ0000000AB-2000';
		const sf = salesforce([{ items: [{ item: a.item, cvs: [a.cv] }], next }, { items: [{ item: b.item, cvs: [b.cv] }] }]);
		const q = captureQueue();

		await run(q, sf);

		expect(sf.urls.at(-1)).toBe(`https://example.my.salesforce.com${next}`);
		expect(q.sent).toHaveLength(2);
	});

	it.each([
		['another host', 'https://evil.example/services/data/v68.0/query/01gX-2000'],
		['a non-query path', '/services/data/v68.0/sobjects/User'],
	])('refuses a next-page link to %s, queuing nothing', async (_label, next) => {
		const a = newRef();
		const q = captureQueue();

		await expect(run(q, salesforce([{ items: [{ item: a.item, cvs: [a.cv] }], next }]))).rejects.toThrow(SalesforceError);
		expect(q.sent).toHaveLength(0);
	});

	it('sends nothing when everything is already in Drive', async () => {
		const done = newRef();
		await recordUpload(
			db,
			{ contentVersionId: done.cv, applicationId: 'a00000000000501AAA', documentType: 'Resume', sequence: 1, driveFileId: 'f' },
			1,
		);
		await markScreened(done);
		const q = captureQueue();

		const result = await run(q, salesforce([{ items: [{ item: done.item, cvs: [done.cv] }] }]));

		expect(q.calls()).toBe(0);
		expect(result.queued).toBe(0);
	});

	it('caps one run, leaving the rest for the next', async () => {
		const refs = Array.from({ length: MAX_PER_RUN + 50 }, newRef);
		const q = captureQueue();

		const result = await run(q, salesforce([{ items: refs.map((r) => ({ item: r.item, cvs: [r.cv] })) }]));

		expect(q.calls()).toBe(1);
		expect(q.sent).toHaveLength(MAX_PER_RUN);
		expect(result.deferred).toBe(50);
	});
	it('queues files in Drive that were never screened, so the consumer can finish them', async () => {
		const old = newRef();
		await recordUpload(
			db,
			{ contentVersionId: old.cv, applicationId: 'a00000000000502AAA', documentType: 'Resume', sequence: 1, driveFileId: 'f' },
			1,
		);
		const q = captureQueue();

		const result = await run(q, salesforce([{ items: [{ item: old.item, cvs: [old.cv] }] }]));

		expect(q.sent.map((b) => b.contentVersionId)).toEqual([old.cv]);
		expect(result).toMatchObject({ found: 1, alreadyUploaded: 0, unscreened: 1, queued: 1 });
	});

	it('leaves held files alone, in Drive or not', async () => {
		const heldInDrive = newRef();
		const heldElsewhere = newRef();
		await recordUpload(
			db,
			{ contentVersionId: heldInDrive.cv, applicationId: 'a00000000000503AAA', documentType: 'Resume', sequence: 1, driveFileId: 'f' },
			1,
		);
		await db.batch(
			[heldInDrive, heldElsewhere].map((r) =>
				db.prepare('INSERT INTO screen_holds (content_version_id, reason, held_at) VALUES (?, ?, ?)').bind(r.cv, 'eval_test_set', 1),
			),
		);
		const q = captureQueue();

		const result = await run(
			q,
			salesforce([
				{
					items: [
						{ item: heldInDrive.item, cvs: [heldInDrive.cv] },
						{ item: heldElsewhere.item, cvs: [heldElsewhere.cv] },
					],
				},
			]),
		);

		expect(q.sent).toHaveLength(0);
		expect(result.held).toBe(2);
	});
	it("spreads a batch out by the pacing gap, so jobs don't collide at the screener", async () => {
		const refs = [newRef(), newRef(), newRef()];
		const q = captureQueue();

		await run(q, salesforce([{ items: refs.map((r) => ({ item: r.item, cvs: [r.cv] })) }]));

		expect(q.delays).toEqual([0, STAGGER_SECONDS, 2 * STAGGER_SECONDS]);
	});
});
