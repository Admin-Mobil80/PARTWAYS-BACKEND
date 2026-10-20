import crypto from 'node:crypto';

// PartWays Interview Id: PW-XXXX-XXXX in Crockford base32 (no I, L, O or U), so it
// reads clearly over the phone. About 10^12 combinations; uniqueness is checked
// against the global index when a participant is created.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const code = (n) => Array.from({ length: n }, () => CROCKFORD[crypto.randomInt(CROCKFORD.length)]).join('');

export const newInterviewId = () => `PW-${code(4)}-${code(4)}`;
export const isInterviewId = (s) => /^PW-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(String(s || '').toUpperCase());
