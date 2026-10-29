import type { IDataObject } from 'n8n-workflow';
import { apiRequest, numberPath, requestMany } from '../transport/request';
import * as v from '../validation';
import { type Handler, SIMPLE_FIELDS, locator, param, simplifier } from './shared';

const get: Handler = (context, i, ref, s) => {
	const path = `${numberPath(ref)}/groups/${v.groupId(s, locator(context, 'groupId', i))}`;
	const shape = simplifier(s, context, i);
	return async () =>
		shape(await apiRequest(context, { method: 'GET', path, itemIndex: i }), SIMPLE_FIELDS.group);
};

const getMany: Handler = (context, i, ref, s) => {
	const returnAll = v.asBoolean(s, param(context, 'returnAll', i, false), 'Return All');
	const limit = returnAll ? 0 : v.limitValue(s, param(context, 'limit', i, 50));
	const filters = param<IDataObject>(context, 'filters', i, {});
	const qs: IDataObject = {};
	const name = v.filterValue(s, filters, 'name', 'Name');
	if (name) qs.name = name;
	if (filters.includeLeft !== undefined)
		qs.include_left = v.asBoolean(s, filters.includeLeft, 'Include Groups Left');
	const shape = simplifier(s, context, i);
	return async () => {
		const items = await requestMany(
			context,
			{ path: `${numberPath(ref)}/groups`, qs, itemIndex: i },
			returnAll,
			limit,
		);
		return items.map((item) => shape(item, SIMPLE_FIELDS.group));
	};
};

export const groupHandlers: Record<string, Handler> = { get, getMany };
