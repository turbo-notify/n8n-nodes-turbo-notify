import type { IDataObject } from 'n8n-workflow';
import { ACCEPTED, MESSAGE, PHONE, makeExecuteContext, node } from './helpers';

const rows = (count: number, bad: number): IDataObject[] =>
	Array.from({ length: count }, (_, i) => ({
		...MESSAGE,
		operation: 'sendText',
		phoneNumber: i === bad ? 'not a number' : PHONE,
		text: `row ${i}`,
	}));
const items = (count: number) => Array.from({ length: count }, () => ({ json: {} }));

describe('one bad row among many', () => {
	it('stops the run before anything is sent', async () => {
		const { context, request } = makeExecuteContext({
			params: rows(5, 3),
			items: items(5),
			responses: Array(5).fill(ACCEPTED),
		});
		await expect(node.execute.call(context)).rejects.toThrow(/\[Item 3\]/);
		expect(request).not.toHaveBeenCalled();
	});

	it('with Continue On Fail sends the good rows and reports the bad one with its hint', async () => {
		const { context, request } = makeExecuteContext({
			params: rows(3, 1),
			items: items(3),
			responses: [ACCEPTED, ACCEPTED],
			continueOnFail: true,
		});
		const result = await node.execute.call(context);
		expect(request).toHaveBeenCalledTimes(2);
		expect(result[0]?.[1]?.json).toMatchObject({
			error: expect.stringMatching(/Phone Number/),
			hint: expect.stringMatching(/\+5511977770001/),
		});
		expect(result[0]?.map((item) => item.pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
	});

	it('a failure while sending is reported on the item that failed', async () => {
		const { context, request } = makeExecuteContext({
			params: rows(2, -1),
			items: items(2),
			continueOnFail: true,
		});
		request.mockReset();
		request.mockResolvedValueOnce(ACCEPTED).mockRejectedValueOnce(
			Object.assign(new Error('x'), {
				httpCode: '404',
				response: { status: 404, data: { error: 'number_not_found' } },
			}),
		);
		const result = await node.execute.call(context);
		expect(result[0]?.[1]?.json.error).toMatch(/number_not_found/);
		expect(result[0]?.[1]?.pairedItem).toEqual({ item: 1 });
	});
});
