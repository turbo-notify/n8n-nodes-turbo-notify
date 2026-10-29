import { contactHandlers } from './contact';
import { eventHandlers } from './event';
import { groupHandlers } from './group';
import { messageHandlers } from './message';
import { numberHandlers } from './number';
import type { Handler } from './shared';

export type { Handler, Run } from './shared';

export const handlers: Record<string, Record<string, Handler>> = {
	message: messageHandlers,
	contact: contactHandlers,
	group: groupHandlers,
	number: numberHandlers,
	event: eventHandlers,
};
