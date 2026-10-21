// BMS sign-in for the PartWays team: a 6-digit code by email, like the website,
// but against its own Cognito user pool, so a website account can never sign in
// here. Only the root (BMS_ROOT_EMAIL) and team members the root adds may sign in.
// Locally, codes are kept in the store and printed to the dev server console.
import crypto from 'node:crypto';
import {
  CognitoIdentityProviderClient, AdminGetUserCommand, AdminCreateUserCommand,
  InitiateAuthCommand, RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getStore } from '../store/index.js';
import { fail } from '../lib/http.js';

const mode = () => (process.env.BMS_USER_POOL_ID ? 'cognito' : 'local');
const SECRET = () => process.env.AUTH_SECRET || 'partways-local-development-secret';
const AUDIENCE = 'partways-bms';
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const SESSION_HOURS = 8;

const g = () => getStore('global');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rootEmail = () => String(process.env.BMS_ROOT_EMAIL || '').trim().toLowerCase();

export function normaliseEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email address.');
  return e;
}

// The root is always a member; it is recorded the first time it is looked up.
export async function teamMember(email) {
  if (email && email === rootEmail()) {
    const existing = await g().get('bmsmember', email);
    if (existing?.role === 'root') return existing;
    const root = { id: email, email, role: 'root', addedAt: new Date().toISOString(), addedBy: null };
    await g().put('bmsmember', root);
    return root;
  }
  const member = await g().get('bmsmember', email);
  return member?.role === 'admin' ? member : null;
}

// --- Local tokens: HMAC-signed, with an audience so a website token is never accepted here.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', SECRET()).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyLocal(token) {
  const [head, body, sig] = String(token).split('.');
  if (!sig) return null;
  const expected = crypto.createHmac('sha256', SECRET()).update(`${head}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.aud === AUDIENCE && p.exp * 1000 > Date.now() ? p : null;
}

let cognito, verifier;
const idp = () => (cognito ||= new CognitoIdentityProviderClient({}));

export async function startLogin(emailRaw) {
  const email = normaliseEmail(emailRaw);
  if (!(await teamMember(email))) fail(403, 'This email is not on the PartWays team.');
  if (mode() === 'local') {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await g().put('bmsotp', { id: hash(email), codeHash: hash(code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
    console.log(`\n[PartWays BMS] Sign-in code for ${email}: ${code}\n`);
    return { session: null, delivery: 'console', ...(process.env.DEV_SHOW_OTP === '1' ? { devCode: code } : {}) };
  }
  const UserPoolId = process.env.BMS_USER_POOL_ID;
  try {
    await idp().send(new AdminGetUserCommand({ UserPoolId, Username: email }));
  } catch (err) {
    if (err.name !== 'UserNotFoundException') throw err;
    await idp().send(new AdminCreateUserCommand({
      UserPoolId, Username: email, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
    }));
  }
  const res = await idp().send(new InitiateAuthCommand({
    AuthFlow: 'CUSTOM_AUTH', ClientId: process.env.BMS_CLIENT_ID, AuthParameters: { USERNAME: email },
  }));
  return { session: res.Session, delivery: 'email' };
}

export async function verifyLogin(emailRaw, codeRaw, session) {
  const email = normaliseEmail(emailRaw);
  const code = String(codeRaw || '').replace(/\D/g, '');
  if (code.length !== 6) fail(400, 'Enter the 6-digit code from the email.');
  const member = await teamMember(email);
  if (!member) fail(403, 'This email is not on the PartWays team.');
  if (mode() === 'local') {
    const rec = await g().get('bmsotp', hash(email));
    if (!rec || rec.expiresAt < Date.now()) fail(400, 'This code has expired. Request a new one.');
    if (rec.codeHash !== hash(code)) {
      rec.attempts += 1;
      if (rec.attempts >= MAX_ATTEMPTS) { await g().delete('bmsotp', rec.id); fail(400, 'Too many incorrect attempts. Request a new code.'); }
      await g().put('bmsotp', rec);
      fail(400, `That code is not right. ${MAX_ATTEMPTS - rec.attempts} attempt${MAX_ATTEMPTS - rec.attempts === 1 ? '' : 's'} left.`);
    }
    await g().delete('bmsotp', rec.id);
    const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
    return { token: sign({ sub: email, email, aud: AUDIENCE, exp }), email, role: member.role, expiresAt: exp * 1000 };
  }
  try {
    const res = await idp().send(new RespondToAuthChallengeCommand({
      ClientId: process.env.BMS_CLIENT_ID, ChallengeName: 'CUSTOM_CHALLENGE', Session: session,
      ChallengeResponses: { USERNAME: email, ANSWER: code },
    }));
    if (res.AuthenticationResult) {
      return { token: res.AuthenticationResult.IdToken, email, role: member.role, expiresAt: Date.now() + res.AuthenticationResult.ExpiresIn * 1000 };
    }
    return { retry: true, session: res.Session, error: 'That code is not right. Please try again.' };
  } catch (err) {
    if (err.name === 'NotAuthorizedException') fail(400, 'Too many incorrect attempts or the code expired. Request a new code.');
    throw err;
  }
}

async function identify(req) {
  const h = req.headers?.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  if (mode() === 'local') return verifyLocal(token)?.email || null;
  verifier ||= CognitoJwtVerifier.create({ userPoolId: process.env.BMS_USER_POOL_ID, tokenUse: 'id', clientId: process.env.BMS_CLIENT_ID });
  try {
    return (await verifier.verify(token)).email;
  } catch {
    return null;
  }
}

// The signed-in team member, checked on every request so removal takes effect at once.
export async function authenticate(req) {
  const email = await identify(req);
  if (!email) return null;
  const member = await teamMember(email);
  return member ? { email, role: member.role } : null;
}
