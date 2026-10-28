import type { IDataObject } from 'n8n-workflow';
import { TurboNotifyTrigger } from '../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node';
import { API, makeExecuteContext, makePollContext } from './helpers';

const trigger = new TurboNotifyTrigger();

const ev = (n: number, type = 'message.received') => ({
	id: `evt_${String(n).padStart(32, '0')}`,
	type,
	organization_id: 'org_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
	number_alias: 'main',
	number_id: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
	created_at: `2026-10-28T10:00:${String(n).padStart(2, '0')}Z`,
	data: { id: `msg_${n}`, preview: `m${n}` },
});
const list = (events: IDataObject[], hasMore = false) => ({ object: 'list', data: events, has_more: hasMore });
const ids = (r: Awaited<ReturnType<typeof trigger.poll>>) => (r?.[0] ?? []).map((i) => (i.json as IDataObject).id);

const params = { events: ['message.received'] };

describe('Turbo Notify Trigger (polling)', () => {
	it('is a polling trigger with no inputs', () => {
		expect(trigger.description.polling).toBe(true);
		expect(trigger.description.inputs).toEqual([]);
		expect(trigger.description.group).toEqual(['trigger']);
	});

	it('first poll stores the newest event as the cursor and emits nothing', async () => {
		const { context, request, staticData } = makePollContext({ params, responses: [list([ev(5)])] });
		const result = await trigger.poll.call(context);
		expect(result).toBeNull();
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			method: 'GET',
			url: `${API}/events`,
			qs: { types: ['message.received'], limit: 1 },
		});
		expect(staticData.lastEventId).toBe(ev(5).id);
		expect(staticData.lastCreatedAt).toBe(ev(5).created_at);
	});

	it('first poll with no events leaves the workflow ready for the next poll', async () => {
		const { context, staticData } = makePollContext({ params, responses: [list([])] });
		expect(await trigger.poll.call(context)).toBeNull();
		expect(staticData.initialized).toBe(true);
		expect(staticData.lastEventId).toBeUndefined();
	});

	it('later poll emits only new events, oldest first, and moves the cursor', async () => {
		const { context, request, staticData } = makePollContext({
			params,
			staticData: { initialized: true, filterKey: 'message.received|', lastEventId: ev(5).id, lastCreatedAt: ev(5).created_at },
			responses: [list([ev(8), ev(7), ev(6)])],
		});
		const result = await trigger.poll.call(context);
		expect(ids(result)).toEqual([ev(6).id, ev(7).id, ev(8).id]);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[1].qs).toEqual({
			types: ['message.received'],
			limit: 100,
			ending_before: ev(5).id,
			'created[gte]': ev(5).created_at,
		});
		expect(staticData.lastEventId).toBe(ev(8).id);
		expect(staticData.lastCreatedAt).toBe(ev(8).created_at);
	});

	it('emits the full envelope of each event', async () => {
		const { context } = makePollContext({
			params,
			staticData: { initialized: true, filterKey: 'message.received|', lastEventId: ev(1).id, lastCreatedAt: ev(1).created_at },
			responses: [list([ev(2)])],
		});
		const result = await trigger.poll.call(context);
		expect(result?.[0]?.[0]?.json).toEqual(ev(2));
	});

	it('returns null when nothing is new', async () => {
		const { context, staticData } = makePollContext({
			params,
			staticData: { initialized: true, filterKey: 'message.received|', lastEventId: ev(5).id, lastCreatedAt: ev(5).created_at },
			responses: [list([])],
		});
		expect(await trigger.poll.call(context)).toBeNull();
		expect(staticData.lastEventId).toBe(ev(5).id);
	});

	it('follows a full page with starting_after until the cursor is reached', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ev(300 - i));
		const page2 = [ev(200), ev(199), ev(150)];
		const { context, request } = makePollContext({
			params,
			staticData: { initialized: true, filterKey: 'message.received|', lastEventId: ev(150).id, lastCreatedAt: ev(150).created_at },
			responses: [list(page1, true), list(page2, false)],
		});
		const result = await trigger.poll.call(context);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1]?.[1].qs).toMatchObject({ starting_after: ev(201).id, limit: 100 });
		expect(request.mock.calls[1]?.[1].qs['ending_before']).toBeUndefined();
		const emitted = ids(result);
		expect(emitted).toHaveLength(100 + 2);
		expect(emitted[0]).toBe(ev(199).id);
		expect(emitted[emitted.length - 1]).toBe(ev(300).id);
		expect(emitted).not.toContain(ev(150).id);
	});

	it('sends several event types and the number filter', async () => {
		const { context, request } = makePollContext({
			params: { events: ['message.received', 'message.read'], options: { numberAlias: 'vendas-sp' } },
			responses: [list([])],
		});
		await trigger.poll.call(context);
		expect(request.mock.calls[0]?.[1].qs).toEqual({
			types: ['message.received', 'message.read'],
			limit: 1,
			number_alias: 'vendas-sp',
		});
	});

	it('starts over (no flood) when the selected events change', async () => {
		const { context, staticData } = makePollContext({
			params: { events: ['message.read'] },
			staticData: { initialized: true, filterKey: 'message.received|', lastEventId: ev(5).id, lastCreatedAt: ev(5).created_at },
			responses: [list([ev(9, 'message.read')])],
		});
		expect(await trigger.poll.call(context)).toBeNull();
		expect(staticData.lastEventId).toBe(ev(9, 'message.read').id);
		expect(staticData.filterKey).toBe('message.read|');
	});

	it('manual run returns the latest event as sample data', async () => {
		const { context, staticData } = makePollContext({ params, mode: 'manual', responses: [list([ev(4)])] });
		const result = await trigger.poll.call(context);
		expect(ids(result)).toEqual([ev(4).id]);
		expect(staticData.lastEventId).toBeUndefined();
	});

	it('manual run without events says what to do', async () => {
		const { context } = makePollContext({ params, mode: 'manual', responses: [list([])] });
		await expect(trigger.poll.call(context)).rejects.toThrow(/No matching event/);
	});

	it('does not move the cursor when the API call is rejected', async () => {
		const { context, request, staticData } = makePollContext({
			params,
			staticData: { initialized: true, filterKey: 'message.received|', lastEventId: ev(5).id, lastCreatedAt: ev(5).created_at },
		});
		request.mockReset();
		request.mockRejectedValue(Object.assign(new Error('boom'), { httpCode: '500', response: { status: 500, data: { error: 'internal_error' } } }));
		await expect(trigger.poll.call(context)).rejects.toThrow(/internal_error/);
		expect(staticData.lastEventId).toBe(ev(5).id);
	});

	it('requires at least one event type', async () => {
		const { context } = makePollContext({ params: { events: [] } });
		await expect(trigger.poll.call(context)).rejects.toThrow(/'Events'/);
	});

	it('refuses more than 20 event types', async () => {
		const { context } = makePollContext({ params: { events: Array.from({ length: 21 }, (_, i) => `message.x${i}`) } });
		await expect(trigger.poll.call(context)).rejects.toThrow(/'Events'/);
	});
});

describe('trigger uses the same credential', () => {
	it('declares turboNotifyApi as required', () => {
		expect(trigger.description.credentials).toEqual([{ name: 'turboNotifyApi', required: true }]);
		expect(makeExecuteContext).toBeDefined();
	});
});
