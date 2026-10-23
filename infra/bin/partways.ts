#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  ACCOUNT,
  BMS_DOMAINS,
  BMS_PREFIX,
  BMS_ROOT_EMAIL,
  DNS_REGION,
  ELEVENLABS_ZERO_RETENTION,
  GITHUB_OWNER,
  INVITE_FROM_ADDRESS,
  WHATSAPP_PHONE_NUMBER_ID,
  HR_ALLOWED_EMAILS,
  LLM_MODEL,
  LLM_PROVIDER,
  MAIL_ACCOUNT,
  MAIL_REGION,
  MAIL_SENDER_ROLE_NAME,
  PORTAL_DOMAINS,
  PORTAL_API_ROLE_NAME,
  PORTAL_PREFIX,
  PREFIX,
  REGION,
  WEBAPPS_BUCKET_NAME,
} from '../lib/account';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { HostingStack } from '../lib/hosting-stack';
import { MailerStack } from '../lib/mailer-stack';
import { StaticSiteStack } from '../lib/static-site-stack';

const app = new cdk.App();
const stacks: cdk.Stack[] = [];

// Sign-in mail goes through the m80 account's SES. This is the only stack in
// m80; deploy it with the m80 profile. Everything else is in ACCOUNT.
stacks.push(
  new MailerStack(app, 'partways-mailer', {
    env: { account: MAIL_ACCOUNT, region: MAIL_REGION },
    stackName: `${PREFIX}-mailer`,
    description: `PartWays sign-in mail: the partways.org SES identity and a send-only role for account ${ACCOUNT}`,
  }),
);

stacks.push(
  new DnsStack(app, 'partways-dns', {
    env: { account: ACCOUNT, region: DNS_REGION },
    stackName: `${PREFIX}-dns`,
    description: 'PartWays partways.org records: DKIM, MAIL FROM and DMARC for mail sent through m80 SES',
  }),
);

// `-c region=…` exists only to synth before REGION is chosen; deploys use the constant.
const region: string | undefined = REGION || app.node.tryGetContext('region');
if (region) {
  stacks.push(...appStacks({ account: ACCOUNT, region }));
} else {
  console.warn('REGION is not set in lib/account.ts: only partways-mailer and partways-dns are defined.');
}

// The account is shared with nothing else today, but tags keep PartWays'
// resources identifiable, as in every other WingTheIdea product.
for (const stack of stacks) {
  cdk.Tags.of(stack).add('project', PREFIX);
  cdk.Tags.of(stack).add('managed-by', 'cdk');
  cdk.Tags.of(stack).add('repo', `${GITHUB_OWNER}/PARTWAYS-BACKEND`);
}

function appStacks(env: cdk.Environment): cdk.Stack[] {
  const senderRoleArn = `arn:aws:iam::${MAIL_ACCOUNT}:role/${MAIL_SENDER_ROLE_NAME}`;

  const data = new DataStack(app, 'partways-data', {
    env,
    stackName: `${PREFIX}-data`,
    description: 'PartWays table and provider keys',
  });

  const auth = new AuthStack(app, 'partways-auth', {
    env,
    stackName: `${PREFIX}-auth`,
    description: 'PartWays HR sign-in: Cognito custom auth with 6-digit email codes sent through m80 SES',
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
    bucketName: WEBAPPS_BUCKET_NAME,
    sitePrefix: PORTAL_PREFIX,
    domainNames: PORTAL_DOMAINS,
    githubOidcProviderArn: hosting.githubOidcProviderArn,
    api: {
      file: 'api',
      // m80's send-only role trusts this role by name, for invitation emails.
      roleName: PORTAL_API_ROLE_NAME,
      environment: {
        SES_ROLE_ARN: senderRoleArn,
        SES_REGION: MAIL_REGION,
        INVITE_FROM_ADDRESS,
        WHATSAPP_PHONE_NUMBER_ID,
        SITE_URL: `https://${PORTAL_DOMAINS[0]}`,
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
        fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [senderRoleArn] }));
        // WhatsApp invitations and reminders, from the linked PartWays number only.
        if (WHATSAPP_PHONE_NUMBER_ID) {
          fn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['social-messaging:SendWhatsAppMessage'],
            resources: [`arn:aws:social-messaging:${REGION}:${ACCOUNT}:phone-number-id/${WHATSAPP_PHONE_NUMBER_ID.replace(/^phone-number-id-/, '')}`],
          }));
        }
        // Creates an organisation's people on sign-up and team changes; cannot delete anyone.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser'],
            resources: [auth.userPool.userPoolArn],
          }),
        );
      },
    },
  });

  // The back-office for the PartWays team: organisations, credits, team, audit log.
  const bms = new StaticSiteStack(app, 'partways-bms', {
    env,
    stackName: `${PREFIX}-bms`,
    description: 'PartWays BMS: CloudFront for the back-office, its API, and its GitHub Actions deploy role',
    appName: 'bms',
    githubRepo: `${GITHUB_OWNER}/PARTWAYS-BMS`,
    bucketName: WEBAPPS_BUCKET_NAME,
    sitePrefix: BMS_PREFIX,
    domainNames: BMS_DOMAINS,
    githubOidcProviderArn: hosting.githubOidcProviderArn,
    api: {
      file: 'bms-api',
      environment: {
        TABLE_NAME: data.table.tableName,
        BMS_USER_POOL_ID: auth.bmsUserPool.userPoolId,
        BMS_CLIENT_ID: auth.bmsClient.userPoolClientId,
        BMS_ROOT_EMAIL,
      },
      grant: (fn) => {
        data.table.grantReadWriteData(fn);
        // Creates a team member's sign-in on first use; cannot delete anyone.
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser'],
            resources: [auth.bmsUserPool.userPoolArn],
          }),
        );
      },
    },
  });

  return [data, auth, hosting, portal, bms];
}
