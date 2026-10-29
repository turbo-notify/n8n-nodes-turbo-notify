import type { IDataObject } from 'n8n-workflow';

export interface PollState {
	initialized?: boolean;
	filterKey?: string;
	/** Newest created_at seen, as the API wrote it. Polls look back from here, see LOOKBACK_MS. */
	lastCreatedAt?: string;
	/** IDs of the events already handed on that are still inside the look-back window. */
	seenIds?: string[];
}

export const MAX_SEEN = 5000;

/**
 * An event takes its `created_at` (whole seconds) when it is built, not when it becomes visible, and several
 * events can share a second. A cursor on the newest event can therefore pass one that appears a moment later.
 * Every poll reads the last two minutes again and hands on only the IDs it has not handed on before.
 */
export const LOOKBACK_MS = 120_000;

export const sinceOf = (createdAt: string): string =>
	new Date(Date.parse(createdAt) - LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

const timeOf = (event: IDataObject): number => Date.parse(String(event.created_at ?? ''));

/** First poll: whatever is already there counts as seen, so the workflow never runs on history. */
export function start(
	state: PollState,
	filterKey: string,
	newest: IDataObject | undefined,
	window: IDataObject[],
	now: Date,
): void {
	state.initialized = true;
	state.filterKey = filterKey;
	if (typeof newest?.created_at === 'string') {
		state.lastCreatedAt = newest.created_at;
		state.seenIds = window.map((event) => String(event.id));
	} else {
		state.lastCreatedAt = now.toISOString();
		state.seenIds = [];
	}
}

/**
 * Later polls: `recent` is every event of the look-back window, newest first. Returns the ones not handed on
 * before (newest first) and moves the window forward.
 */
export function advance(state: PollState, recent: IDataObject[]): IDataObject[] {
	const lastCreatedAt = state.lastCreatedAt ?? new Date().toISOString();
	const seen = new Set(state.seenIds);
	const fresh = recent.filter((event) => !seen.has(String(event.id)));

	let newest = { time: Date.parse(lastCreatedAt), text: lastCreatedAt };
	for (const event of recent) {
		const time = timeOf(event);
		if (time > newest.time) newest = { time, text: String(event.created_at) };
	}
	const horizon = newest.time - LOOKBACK_MS;
	state.lastCreatedAt = newest.text;
	state.seenIds = recent
		.filter((event) => timeOf(event) >= horizon)
		.map((event) => String(event.id))
		.slice(0, MAX_SEEN);
	return fresh;
}
