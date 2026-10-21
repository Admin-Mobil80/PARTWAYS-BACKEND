// Invitation and reminder emails. In AWS they go through the m80 account's SES
// (out of the sandbox) by assuming its send-only role, like the sign-in codes.
// Without INVITE_FROM_ADDRESS (local development) nothing is sent: the email is
// printed to the console and reported as simulated.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

let client;
function ses() {
  if (client) return client;
  const RoleArn = process.env.SES_ROLE_ARN;
  if (!RoleArn) return (client = new SESv2Client({}));
  const sts = new STSClient({});
  client = new SESv2Client({
    region: process.env.SES_REGION,
    credentials: async () => {
      const { Credentials: c } = await sts.send(new AssumeRoleCommand({ RoleArn, RoleSessionName: 'partways-invitations' }));
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    },
  });
  return client;
}

export const emailLive = () => !!process.env.INVITE_FROM_ADDRESS;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Plain text with the link also as a button, so it reads well in any mail client.
function html(text, link, cta) {
  const paras = escapeHtml(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>').replace(escapeHtml(link), `<a href="${escapeHtml(link)}" style="color:#3f3a8c">${escapeHtml(link)}</a>`)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:Inter,Segoe UI,Arial,sans-serif;color:#17161c">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:600;font-size:16px;margin-bottom:16px">PartWays</div>
<div style="background:#ffffff;border:1px solid #e4e2dc;border-radius:12px;padding:24px;font-size:15px;line-height:1.55">${paras}
<p style="margin:20px 0 4px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#3f3a8c;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(cta)}</a></p>
</div>
<p style="font-size:12px;color:#6b6975;margin:16px 4px 0">PartWays is an independent exit interview service. You received this because your organisation asked PartWays to invite you.</p>
</div></body></html>`;
}

export async function sendEmail({ to, subject, text, link, cta = 'Open your interview' }) {
  if (!emailLive()) {
    console.log(`\n[PartWays] Email to ${to} (not sent: local development)\nSubject: ${subject}\n\n${text}\n`);
    return { simulated: true };
  }
  const res = await ses().send(new SendEmailCommand({
    FromEmailAddress: `PartWays <${process.env.INVITE_FROM_ADDRESS}>`,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: subject },
      Body: { Text: { Data: text }, Html: { Data: html(text, link, cta) } },
    } },
  }));
  return { simulated: false, messageId: res.MessageId };
}
