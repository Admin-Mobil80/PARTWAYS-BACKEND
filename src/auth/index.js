// HR sign-in with a 6-digit code sent by email. In AWS this is a Cognito custom
// authentication flow (codes sent through SES by the challenge triggers); locally
// codes are kept in the store and printed to the dev server console.
// Each account belongs to one organisation workspace; a free sign-up creates both.
import crypto from 'node:crypto';
import {
  CognitoIdentityProviderClient, AdminGetUserCommand, AdminCreateUserCommand,
  InitiateAuthCommand, RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getStore } from '../store/index.js';
import { createOrganisation } from '../domain/workspaces.js';
import { fail } from '../lib/http.js';

const mode = () => (process.env.COGNITO_USER_POOL_ID ? 'cognito' : 'local');
const SECRET = () => process.env.AUTH_SECRET || 'partways-local-development-secret';
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export function normaliseEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email address.');
  return e;
}

// HR_ALLOWED_EMAILS: optional comma-separated addresses or @domain entries. Empty allows anyone to sign up.
function isAllowed(email) {
  const list = (process.env.HR_ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  return list.some((x) => (x.startsWith('@') ? email.endsWith(x) : email === x));
}

const g = () => getStore('global');
const SIGNUP_TTL_MS = 30 * 60 * 1000;

export const getAccount = (email) => g().get('user', email);

// Free sign-up: remember the organisation details until the email code is confirmed.
export async function startSignup(body) {
  const email = normaliseEmail(body?.email);
  const orgName = String(body?.orgName || '').trim().slice(0, 120);
  const name = String(body?.name || '').trim().slice(0, 80);
  const country = String(body?.country || '').trim().toUpperCase();
  if (orgName.length < 2) fail(400, 'Enter your organisation’s name.');
  if (!/^[A-Z]{2}$/.test(country)) fail(400, 'Choose your country.');
  if (!isAllowed(email)) fail(403, 'Sign-up is not open for this email address.');
  if (await getAccount(email)) fail(409, 'This email already has a PartWays workspace. Sign in instead.');
  await g().put('signup', { id: email, orgName, name, country, expiresAt: Date.now() + SIGNUP_TTL_MS });
  return sendCode(email);
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
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
  return p.exp * 1000 > Date.now() ? p : null;
}

let cognito, verifier;
const idp = () => (cognito ||= new CognitoIdentityProviderClient({}));

export async function startLogin(emailRaw) {
  const email = normaliseEmail(emailRaw);
  if (!isAllowed(email)) fail(403, 'This email address is not set up for PartWays.');
  if (!(await getAccount(email))) fail(404, 'No PartWays workspace uses this email yet. Create a free account to get started.');
  return sendCode(email);
}

async function sendCode(email) {
  if (mode() === 'local') {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await g().put('otp', { id: hash(email), codeHash: hash(code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
    console.log(`\n[PartWays] Sign-in code for ${email}: ${code}\n`);
    return { session: null, delivery: 'console', ...(process.env.DEV_SHOW_OTP === '1' ? { devCode: code } : {}) };
  }
  const UserPoolId = process.env.COGNITO_USER_POOL_ID;
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
    AuthFlow: 'CUSTOM_AUTH', ClientId: process.env.COGNITO_CLIENT_ID, AuthParameters: { USERNAME: email },
  }));
  return { session: res.Session, delivery: 'email' };
}

export async function verifyLogin(emailRaw, codeRaw, session) {
  const email = normaliseEmail(emailRaw);
  const code = String(codeRaw || '').replace(/\D/g, '');
  if (code.length !== 6) fail(400, 'Enter the 6-digit code from the email.');
  if (mode() === 'local') {
    const store = g();
    const rec = await store.get('otp', hash(email));
    if (!rec || rec.expiresAt < Date.now()) fail(400, 'This code has expired. Request a new one.');
    if (rec.codeHash !== hash(code)) {
      rec.attempts += 1;
      if (rec.attempts >= MAX_ATTEMPTS) { await store.delete('otp', rec.id); fail(400, 'Too many incorrect attempts. Request a new code.'); }
      await store.put('otp', rec);
      fail(400, `That code is not right. ${MAX_ATTEMPTS - rec.attempts} attempt${MAX_ATTEMPTS - rec.attempts === 1 ? '' : 's'} left.`);
    }
    await store.delete('otp', rec.id);
    const account = await ensureAccount(email);
    const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
    return { token: sign({ sub: email, email, exp }), email, expiresAt: exp * 1000, ...account };
  }
  try {
    const res = await idp().send(new RespondToAuthChallengeCommand({
      ClientId: process.env.COGNITO_CLIENT_ID, ChallengeName: 'CUSTOM_CHALLENGE', Session: session,
      ChallengeResponses: { USERNAME: email, ANSWER: code },
    }));
    if (res.AuthenticationResult) {
      const account = await ensureAccount(email);
      return { token: res.AuthenticationResult.IdToken, email, expiresAt: Date.now() + res.AuthenticationResult.ExpiresIn * 1000, ...account };
    }
    return { retry: true, session: res.Session, error: 'That code is not right. Please try again.' };
  } catch (err) {
    if (err.name === 'NotAuthorizedException') fail(400, 'Too many incorrect attempts or the code expired. Request a new code.');
    throw err;
  }
}

// After a confirmed code: the existing account, or the organisation from a pending sign-up.
async function ensureAccount(email) {
  const existing = await getAccount(email);
  if (existing) return { orgId: existing.orgId, created: false };
  const pending = await g().get('signup', email);
  if (!pending || pending.expiresAt < Date.now()) fail(404, 'No PartWays workspace uses this email yet. Create a free account to get started.');
  const { orgId } = await createOrganisation({ orgName: pending.orgName, name: pending.name, country: pending.country, email });
  await g().delete('signup', email);
  return { orgId, created: true };
}

async function identify(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  if (mode() === 'local') {
    const p = verifyLocal(token);
    return p ? p.email : null;
  }
  verifier ||= CognitoJwtVerifier.create({ userPoolId: process.env.COGNITO_USER_POOL_ID, tokenUse: 'id', clientId: process.env.COGNITO_CLIENT_ID });
  try {
    return (await verifier.verify(token)).email;
  } catch {
    return null;
  }
}

// The signed-in person and their organisation. Returns null when signed out or the account is gone.
export async function authenticate(req) {
  const email = await identify(req);
  if (!email) return null;
  const account = await getAccount(email);
  if (!account) return null;
  return { email, name: account.name, orgId: account.orgId, role: account.role };
}
