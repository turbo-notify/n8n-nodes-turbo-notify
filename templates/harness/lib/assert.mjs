import { isDeepStrictEqual, inspect } from 'node:util';

export class AssertionFailure extends Error {
	constructor(message, details) {
		super(message);
		this.name = 'AssertionFailure';
		this.details = details;
	}
}

const show = (v) => inspect(v, { depth: 6, breakLength: 100, maxArrayLength: 30 });

/**
 * Small assertion set with messages meant for a template author: every function takes the
 * message of the check as the last argument and counts passes and failures for the report.
 */
export function createAssert(counter = { passed: 0, failed: 0 }) {
	const check = (ok, message, details) => {
		if (ok) {
			counter.passed += 1;
			return;
		}
		counter.failed += 1;
		throw new AssertionFailure(message, details);
	};
	const api = {
		counter,
		ok: (value, message = 'expected a truthy value') => check(Boolean(value), message, { actual: value }),
		equal: (actual, expected, message = 'values differ') =>
			check(isDeepStrictEqual(actual, expected), `${message}\n    expected: ${show(expected)}\n    actual:   ${show(actual)}`, { actual, expected }),
		notEqual: (actual, unexpected, message = 'values should differ') =>
			check(!isDeepStrictEqual(actual, unexpected), `${message}\n    both are: ${show(actual)}`, { actual }),
		match: (text, regex, message = 'text does not match') =>
			check(regex.test(String(text)), `${message}\n    pattern: ${regex}\n    text:    ${show(text)}`, { text }),
		includes: (collection, item, message = 'item missing') => {
			const found = typeof collection === 'string' ? collection.includes(item) : Array.isArray(collection) && collection.some((x) => isDeepStrictEqual(x, item));
			check(found, `${message}\n    looked for: ${show(item)}\n    in:         ${show(collection)}`, { collection, item });
		},
		excludes: (collection, item, message = 'item should be absent') => {
			const found = typeof collection === 'string' ? collection.includes(item) : Array.isArray(collection) && collection.some((x) => isDeepStrictEqual(x, item));
			check(!found, `${message}\n    found:  ${show(item)}\n    in:     ${show(collection)}`, { collection, item });
		},
		/** Every key of `subset` is present in `actual` with a deep equal value (extra keys allowed). */
		subset: (actual, subset, message = 'object does not contain the expected fields') => {
			const bad = [];
			const walk = (a, s, path) => {
				if (s && typeof s === 'object' && !Array.isArray(s)) {
					for (const [k, v] of Object.entries(s)) walk(a?.[k], v, `${path}.${k}`);
				} else if (!isDeepStrictEqual(a, s)) bad.push(`${path}: expected ${show(s)}, got ${show(a)}`);
			};
			walk(actual, subset, '$');
			check(bad.length === 0, `${message}\n    ${bad.join('\n    ')}`, { actual, subset });
		},
		count: (list, n, message = 'wrong count') => check(Array.isArray(list) && list.length === n, `${message}\n    expected ${n}, got ${Array.isArray(list) ? list.length : show(list)}`, { list }),
		fail: (message) => check(false, message),
	};
	return api;
}
