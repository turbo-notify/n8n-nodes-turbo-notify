import type { IDataObject } from 'n8n-workflow';
import { chosenEventTypes } from '../events';
import { requestEvents } from '../transport/request';
import * as v from '../validation';
import { type Handler, param, unwrapLocator } from './shared';

const getMany: Handler = (context, i, _ref, s) => {
	const returnAll = v.asBoolean(s, param(context, 'returnAll', i, false), 'Return All');
	const limit = returnAll ? 0 : v.limitValue(s, param(context, 'limit', i, 50));
	const filters = param<IDataObject>(context, 'filters', i, {});
	const qs: IDataObject = {};
	const types = chosenEventTypes(filters.types);
	if (types.length > 20) {
		v.fail(
			s,
			"'Event Types' accepts up to 20 types",
			'Choose fewer types, or leave the filter out to get every type.',
		);
	}
	if (types.length > 0) qs.types = types;
	if ('number' in filters) {
		const number = v.asString(unwrapLocator(filters.number));
		if (number === '')
			v.fail(
				s,
				"The 'Number' filter is empty",
				'Pick a number, or remove the filter to get the events of every number.',
			);
		qs[/^num_[0-9a-f]{32}$/.test(number) ? 'number_id' : 'number_alias'] = number;
	}
	if (v.asString(filters.createdAfter) !== '')
		qs['created[gte]'] = v.requireDateTime(s, filters.createdAfter, 'Created After');
	if (v.asString(filters.createdBefore) !== '')
		qs['created[lte]'] = v.requireDateTime(s, filters.createdBefore, 'Created Before');
	return () => requestEvents(context, { qs, itemIndex: i }, returnAll, limit);
};

export const eventHandlers: Record<string, Handler> = { getMany };
