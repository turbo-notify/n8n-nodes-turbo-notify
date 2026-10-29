import type { IDataObject } from 'n8n-workflow';
import { apiRequest, numberPath } from '../transport/request';
import { type Handler, param } from './shared';

const get: Handler = (context, i, ref) => async () =>
	apiRequest(context, { method: 'GET', path: numberPath(ref), itemIndex: i });

const getMany: Handler = (context, i) => {
	const filters = param<IDataObject>(context, 'filters', i, {});
	const qs: IDataObject = {};
	if (filters.status) qs.status = filters.status;
	return async () => {
		const page = await apiRequest<{ data?: IDataObject[] }>(context, {
			method: 'GET',
			path: '/numbers',
			qs,
			itemIndex: i,
		});
		return page.data ?? [];
	};
};

export const numberHandlers: Record<string, Handler> = { get, getMany };
