/** How far a delivery's timestamp may be from now: older ones are replays. */
export const TOLERANCE_SECONDS = 300;

/** The part of the Web Crypto API used here. It is a global in the Node versions n8n runs on, so no import is needed. */
interface SubtleCryptoLike {
	importKey(
		format: 'raw',
		key: Uint8Array,
		algorithm: { name: 'HMAC'; hash: 'SHA-256' },
		extractable: boolean,
		usages: string[],
	): Promise<unknown>;
	sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

declare const crypto: { subtle: SubtleCryptoLike };
const subtle = (): SubtleCryptoLike => crypto.subtle;

const toHex = (bytes: ArrayBuffer): string =>
	Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Compares without stopping at the first difference, so the time taken says nothing about the signature. */
function sameText(a: string, b: string): boolean {
	let difference = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return difference === 0;
}

/**
 * Checks a Turbo Notify delivery: `X-Webhook-Signature` is `sha256=` plus the HMAC-SHA256 of
 * `{X-Webhook-Timestamp}.{raw body}` with the secret, and the timestamp (Unix seconds) must be recent.
 */
export async function isGenuine(input: {
	secret: string;
	timestamp: string | undefined;
	signature: string | undefined;
	rawBody: string;
	now?: number;
}): Promise<boolean> {
	const { secret, timestamp, signature, rawBody } = input;
	if (!timestamp || !signature || secret === '') return false;
	const seconds = Number(timestamp);
	const now = (input.now ?? Date.now()) / 1000;
	if (!Number.isFinite(seconds) || Math.abs(now - seconds) > TOLERANCE_SECONDS) return false;

	const encoder = new TextEncoder();
	const key = await subtle().importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const expected = `sha256=${toHex(await subtle().sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)))}`;
	return sameText(expected, signature.trim().toLowerCase());
}
