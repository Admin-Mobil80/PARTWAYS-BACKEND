#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  ACCOUNT,
  ELEVENLABS_ZERO_RETENTION,
  GITHUB_OWNER,
  HR_ALLOWED_EMAILS,
  LLM_MODEL,
  LLM_PROVIDER,
  PORTAL_PREFIX,
  PREFIX,
  REGION,
  SES_FROM_ADDRESS,
} from '../lib/account';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { HostingStack } from '../lib/hosting-stack';
import { StaticSiteStack } from '../lib/static-site-stack';

const app = new cdk.App();

// `-c account=… -c region=…` exists only to synth before lib/account.ts is
// filled in; deploys use the constants.
const account = ACCOUNT || app.node.tryGetContext('account');
const region = REGION || app.node.tryGetContext('region');
const missing = [!account && 'ACCOUNT', !region && 'REGION', !SES_FROM_ADDRESS && 'SES_FROM_ADDRESS'].filter(Boolean);
if (missing.length && !app.node.tryGetContext('account')) {
  throw new Error(`Set ${missing.join(', ')} in lib/account.ts before synthesising or deploying.`);
}
const env: cdk.Environment = { account, region };

const data = new DataStack(app, 'partways-data', {
  env,
  stackName: `${PREFIX}-data`,
  description: 'PartWays table and provider keys',
});

const auth = new AuthStack(app, 'partways-auth', {
  env,
  stackName: `${PREFIX}-auth`,
  description: 'PartWays HR sign-in: Cognito custom auth with 6-digit email codes sent by SES',
});

const hosting = new HostingStack(app, 'partways-hosting', {
  env,
  stackName: `${PREFIX}-hosting`,
  description: 'PartWays hosting bucket (one folder per web app) and the GitHub Actions OIDC provider',
});

const portal = new StaticSiteStack(app, 'partways-portal', {
  env,
  stackName: `${PREFIX}-portal`,
  description: 'PartWays PORTAL: CloudFront for the website, the streaming API, and its GitHub Actions deploy role',
  appName: 'portal',
  githubRepo: `${GITHUB_OWNER}/PARTWAYS-PORTAL`,
  bucketName: hosting.bucketName,
  sitePrefix: PORTAL_PREFIX,
  githubOidcProviderArn: hosting.githubOidcProviderArn,
  api: {
    file: 'api',
    environment: {
      TABLE_NAME: data.table.tableName,
      SECRETS_ARN: data.providerSecrets.secretArn,
      COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
      COGNITO_CLIENT_ID: auth.client.userPoolClientId,
      HR_ALLOWED_EMAILS,
      LLM_PROVIDER,
      LLM_MODEL,
      ELEVENLABS_ZERO_RETENTION,
    },
    grant: (fn) => {
      data.table.grantReadWriteData(fn);
      data.providerSecrets.grantRead(fn);
      // Creates an organisation's people on sign-up and team changes; cannot delete anyone.
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser'],
          resources: [auth.userPool.userPoolArn],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: ['*'],
        }),
      );
    },
  },
});

for (const stack of [data, auth, hosting, portal]) {
  cdk.Tags.of(stack).add('project', PREFIX);
  cdk.Tags.of(stack).add('managed-by', 'cdk');
  cdk.Tags.of(stack).add('repo', `${GITHUB_OWNER}/PARTWAYS-BACKEND`);
}
