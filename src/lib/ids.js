import crypto from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// Invitation tokens are long and unguessable. A seeded random source keeps demo data stable.
export function newToken(rnd) {
  let out = '';
  for (let i = 0; i < 22; i++) {
    const r = rnd ? Math.floor(rnd() * ALPHABET.length) : crypto.randomInt(ALPHABET.length);
    out += ALPHABET[r];
  }
  return out;
}

export function buildPointId(n) {
  return `pt_${n}`;
}
