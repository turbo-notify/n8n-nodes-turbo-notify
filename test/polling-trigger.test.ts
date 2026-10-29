import type { IDataObject } from 'n8n-workflow';
import { TurboNotifyPollingTrigger } from '../nodes/TurboNotifyPollingTrigger/TurboNotifyPollingTrigger.node';
import { API, makeExecuteContext, makePollContext } from './helpers';

const trigger = new TurboNotifyPollingTrigger();

const BASE_MS = Date.UTC(2026, 9, 28, 10, 0, 0);
const at = (seconds: number) =>
	new Date(BASE_MS + seconds * 1000).toISOString().replace('.000Z', 'Z');

// `n` is the order the events were created in; `second` lets several events share one second.
const ev = (n: number, type = 'message.received', second = n) => ({
	id: `evt_${String(n).padStart(32, '0')}`,
	type,
	organization_id: 'org_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
	number_alias: 'main',
	number_id: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
	created_at: at(second),
	data: { id: `msg_${n}`, preview: `m${n}` },
});
const list = (events: IDataObject[], hasMore = false) => ({
	object: 'list',
	data: events,
	has_more: hasMore,
});
const ids = (r: Awaited<ReturnType<typeof trigger.poll>>) =>
	(r?.[0] ?? []).map((i) => (i.json as IDataObject).id);
const seen = (...events: Array<{ id: string }>) => events.map((e) => e.id);

const params = { events: ['message.received'] };
const READY = { initialized: true, filterKey: 'message.received|' };

describe('Turbo Notify Trigger (polling)', () => {
	it('is a polling trigger with no inputs', () => {
		expect(trigger.description.polling).toBe(true);
		expect(trigger.description.inputs).toEqual([]);
		expect(trigger.description.group).toEqual(['trigger']);
	});

	it('first poll marks what is already there as seen and emits nothing', async () => {
		const { context, request, staticData } = makePollContext({
			params,
			responses: [list([ev(5)]), list([ev(5), ev(4)])],
		});
		const result = await trigger.poll.call(context);
		expect(result).toBeNull();
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			method: 'GET',
			url: `${API}/events`,
			qs: { types: ['message.received'], limit: 1 },
		});
		expect(request.mock.calls[1]?.[1].qs).toMatchObject({
			limit: 100,
			'created[gte]': at(5 - 120),
		});
		expect(staticData.lastCreatedAt).toBe(ev(5).created_at);
		expect(staticData.seenIds).toEqual(seen(ev(5), ev(4)));
	});

	it('first poll with no events leaves the workflow ready for the next poll', async () => {
		const { context, staticData } = makePollContext({ params, responses: [list([])] });
		expect(await trigger.poll.call(context)).toBeNull();
		expect(staticData.initialized).toBe(true);
		expect(staticData.seenIds).toEqual([]);
	});

	it('later poll reads the last two minutes and emits only unseen events, oldest first', async () => {
		const { context, request, staticData } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: ev(5).created_at, seenIds: seen(ev(5), ev(4)) },
			responses: [list([ev(8), ev(7), ev(6), ev(5), ev(4)])],
		});
		const result = await trigger.poll.call(context);
		expect(ids(result)).toEqual([ev(6).id, ev(7).id, ev(8).id]);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[1].qs).toEqual({
			types: ['message.received'],
			limit: 100,
			'created[gte]': at(5 - 120),
		});
		expect(staticData.lastCreatedAt).toBe(ev(8).created_at);
		expect(staticData.seenIds).toEqual(seen(ev(8), ev(7), ev(6), ev(5), ev(4)));
	});

	it('does not hand on the same event twice', async () => {
		const { context } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: ev(5).created_at, seenIds: seen(ev(5)) },
			responses: [list([ev(5)])],
		});
		expect(await trigger.poll.call(context)).toBeNull();
	});

	it('emits an event that shares a second with the newest one and sorts lower', async () => {
		// Same second, lower id: a cursor on the newest event would skip it for ever.
		const first = ev(10, 'message.received', 20);
		const late = ev(9, 'message.received', 20);
		const { context } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: first.created_at, seenIds: seen(first) },
			responses: [list([first, late])],
		});
		expect(ids(await trigger.poll.call(context))).toEqual([late.id]);
	});

	it('emits an event that was built earlier but became visible later', async () => {
		const newer = ev(20, 'message.received', 60);
		const lateCommit = ev(19, 'message.received', 58);
		const { context } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: newer.created_at, seenIds: seen(newer) },
			responses: [list([newer, lateCommit])],
		});
		expect(ids(await trigger.poll.call(context))).toEqual([lateCommit.id]);
	});

	it('emits the full envelope of each event', async () => {
		const { context } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: ev(1).created_at, seenIds: seen(ev(1)) },
			responses: [list([ev(2), ev(1)])],
		});
		const result = await trigger.poll.call(context);
		expect(result?.[0]?.[0]?.json).toEqual(ev(2));
	});

	it('returns null when nothing is new', async () => {
		const { context, staticData } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: ev(5).created_at, seenIds: seen(ev(5)) },
			responses: [list([ev(5)])],
		});
		expect(await trigger.poll.call(context)).toBeNull();
		expect(staticData.lastCreatedAt).toBe(ev(5).created_at);
	});

	it('forgets ids that left the look-back window', async () => {
		const old = ev(1, 'message.received', 0);
		const newest = ev(2, 'message.received', 500);
		const { context, staticData } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: at(400), seenIds: seen(old) },
			responses: [list([newest, old])],
		});
		await trigger.poll.call(context);
		expect(staticData.seenIds).toEqual(seen(newest));
	});

	it('follows a full page with starting_after', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ev(300 - i));
		const page2 = [ev(200), ev(199)];
		const { context, request } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: ev(199).created_at, seenIds: seen(ev(199)) },
			responses: [list(page1, true), list(page2, false)],
		});
		const result = await trigger.poll.call(context);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1]?.[1].qs).toMatchObject({ starting_after: ev(201).id, limit: 100 });
		const emitted = ids(result);
		expect(emitted).toHaveLength(101);
		expect(emitted[0]).toBe(ev(200).id);
		expect(emitted[emitted.length - 1]).toBe(ev(300).id);
		expect(emitted).not.toContain(ev(199).id);
	});

	it('sends several event types and the number alias', async () => {
		const { context, request } = makePollContext({
			params: { events: ['message.received', 'message.read'], number: 'vendas-sp' },
			responses: [list([])],
		});
		await trigger.poll.call(context);
		expect(request.mock.calls[0]?.[1].qs).toEqual({
			types: ['message.received', 'message.read'],
			limit: 1,
			number_alias: 'vendas-sp',
		});
	});

	it('uses number_id when the option holds a num_ ID', async () => {
		const id = 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9';
		const { context, request } = makePollContext({
			params: { events: ['message.received'], number: { __rl: true, mode: 'list', value: id } },
			responses: [list([])],
		});
		await trigger.poll.call(context);
		expect(request.mock.calls[0]?.[1].qs).toEqual({
			types: ['message.received'],
			limit: 1,
			number_id: id,
		});
	});

	it('listens to every event and every number when both fields are empty', async () => {
		const { context, request } = makePollContext({
			params: { events: [], number: { __rl: true, mode: 'list', value: '' } },
			responses: [list([])],
		});
		await trigger.poll.call(context);
		expect(request.mock.calls[0]?.[1].qs).toEqual({ limit: 1 });
	});

	it('accepts the events as text separated by commas', async () => {
		const { context, request } = makePollContext({
			params: { events: 'message.received, message.read' },
			responses: [list([])],
		});
		await trigger.poll.call(context);
		expect(request.mock.calls[0]?.[1].qs.types).toEqual(['message.received', 'message.read']);
	});

	it('starts over (no flood) when the selected events change', async () => {
		const { context, staticData } = makePollContext({
			params: { events: ['message.read'] },
			staticData: { ...READY, lastCreatedAt: ev(5).created_at, seenIds: seen(ev(5)) },
			responses: [list([ev(9, 'message.read')]), list([ev(9, 'message.read')])],
		});
		expect(await trigger.poll.call(context)).toBeNull();
		expect(staticData.seenIds).toEqual(seen(ev(9)));
		expect(staticData.filterKey).toBe('message.read|');
	});

	it('manual run returns the latest event as sample data', async () => {
		const { context, staticData } = makePollContext({
			params,
			mode: 'manual',
			responses: [list([ev(4)])],
		});
		const result = await trigger.poll.call(context);
		expect(ids(result)).toEqual([ev(4).id]);
		expect(staticData.seenIds).toBeUndefined();
	});

	it('manual run without events says what to do', async () => {
		const { context } = makePollContext({ params, mode: 'manual', responses: [list([])] });
		await expect(trigger.poll.call(context)).rejects.toThrow(/No matching event/);
	});

	it('does not move the window when the API call is rejected', async () => {
		const { context, request, staticData } = makePollContext({
			params,
			staticData: { ...READY, lastCreatedAt: ev(5).created_at, seenIds: seen(ev(5)) },
		});
		request.mockReset();
		request.mockRejectedValue(
			Object.assign(new Error('boom'), {
				httpCode: '500',
				response: { status: 500, data: { error: 'internal_error' } },
			}),
		);
		await expect(trigger.poll.call(context)).rejects.toThrow(/internal_error/);
		expect(staticData.lastCreatedAt).toBe(ev(5).created_at);
		expect(staticData.seenIds).toEqual(seen(ev(5)));
	});

	it('refuses more than 20 event types, and says leaving it empty means every event', async () => {
		const { context } = makePollContext({
			params: { events: Array.from({ length: 21 }, (_, i) => `message.x${i}`) },
		});
		await expect(trigger.poll.call(context)).rejects.toThrow(/accepts up to 20 event types/);
	});
});

describe('trigger uses the same credential', () => {
	it('declares turboNotifyApi as required', () => {
		expect(trigger.description.credentials).toEqual([{ name: 'turboNotifyApi', required: true }]);
		expect(makeExecuteContext).toBeDefined();
	});
});
