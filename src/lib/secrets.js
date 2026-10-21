// Provider keys live in AWS Secrets Manager as one JSON object, loaded into
// process.env and re-read every few minutes, so a key added or changed in the
// console takes effect without a deploy. Locally they come from .env instead.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REFRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
let client, loadedAt = 0, inFlight = null;
const fromSecret = new Set();

async function load() {
  client ||= new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: process.env.SECRETS_ARN }));
  const values = JSON.parse(res.SecretString || '{}');
  for (const [k, v] of Object.entries(values)) {
    // Never override a value set on the function itself; do update ones that came from here.
    if (v && (!process.env[k] || fromSecret.has(k))) { process.env[k] = String(v); fromSecret.add(k); }
  }
  for (const k of fromSecret) if (!values[k]) { delete process.env[k]; fromSecret.delete(k); }
  loadedAt = Date.now();
}

export function loadSecrets() {
  if (!process.env.SECRETS_ARN) return Promise.resolve();
  if (Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  inFlight ||= load().catch((err) => {
    // A malformed or unreadable secret never takes the API down: keep the keys
    // already loaded (or run without them, in offline mode) and retry in a minute.
    console.error('Could not load provider keys; retrying in a minute', err.name, err.message);
    loadedAt = Date.now() - REFRESH_MS + RETRY_MS;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
