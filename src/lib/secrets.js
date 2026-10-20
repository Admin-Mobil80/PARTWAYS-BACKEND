// Provider keys live in AWS Secrets Manager as one JSON object, loaded once per cold start
// into process.env. Locally they come from .env instead.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let loaded;

export function loadSecrets() {
  if (!process.env.SECRETS_ARN) return Promise.resolve();
  loaded ||= (async () => {
    const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.SECRETS_ARN }));
    const values = JSON.parse(res.SecretString || '{}');
    for (const [k, v] of Object.entries(values)) if (v && !process.env[k]) process.env[k] = String(v);
  })();
  return loaded;
}
