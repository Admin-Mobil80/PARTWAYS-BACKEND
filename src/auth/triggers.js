// Cognito custom authentication triggers: a 6-digit code sent by SES.
import crypto from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const MAX_ATTEMPTS = 3;

// With SES_ROLE_ARN set, codes are sent through another account's SES by
// assuming its send-only role. The SDK caches the credentials until they expire.
function sesClient() {
  const RoleArn = process.env.SES_ROLE_ARN;
  if (!RoleArn) return new SESv2Client({});
  const sts = new STSClient({});
  return new SESv2Client({
    region: process.env.SES_REGION,
    credentials: async () => {
      const { Credentials: c } = await sts.send(new AssumeRoleCommand({ RoleArn, RoleSessionName: 'partways-sign-in' }));
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    },
  });
}
const ses = sesClient();

export async function define(event) {
  const s = event.request.session || [];
  const last = s[s.length - 1];
  if (s.length && last.challengeName === 'CUSTOM_CHALLENGE' && last.challengeResult) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (s.length >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = 'CUSTOM_CHALLENGE';
  }
  return event;
}

export async function create(event) {
  const s = event.request.session || [];
  // Reuse the code across retries in one sign-in so a typo does not trigger a new email.
  let code = s.length ? s[s.length - 1].challengeMetadata?.replace('CODE-', '') : null;
  if (!code) {
    code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const email = event.request.userAttributes.email;
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM_ADDRESS,
      Destination: { ToAddresses: [email] },
      Content: { Simple: {
        Subject: { Data: `${code} is your PartWays sign-in code` },
        Body: { Text: { Data: `Your PartWays sign-in code is ${code}.\n\nIt expires in a few minutes. If you did not try to sign in, you can ignore this email.` } },
      } },
    }));
  }
  event.response.publicChallengeParameters = { delivery: 'email' };
  event.response.privateChallengeParameters = { code };
  event.response.challengeMetadata = `CODE-${code}`;
  return event;
}

export async function verify(event) {
  const expected = event.request.privateChallengeParameters.code;
  const answer = String(event.request.challengeAnswer || '');
  event.response.answerCorrect = answer.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(answer), Buffer.from(expected));
  return event;
}
