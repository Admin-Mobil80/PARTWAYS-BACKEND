// WhatsApp invitations and reminders through AWS End User Messaging Social, from
// the PartWays number linked in this account. WhatsApp only delivers templates
// that Meta has approved, so the wording is the template's (whatsapp/*.json);
// a programme's editable message is used for email. Without
// WHATSAPP_PHONE_NUMBER_ID (local development) nothing is sent: the message is
// printed to the console and reported as simulated.
import { SocialMessagingClient, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging';

let client;
export const whatsappLive = () => !!process.env.WHATSAPP_PHONE_NUMBER_ID;

// Approved template names, and the order of their body variables.
const TEMPLATES = {
  invitation: { name: 'partways_interview_ready', body: (v) => [v.org, v.interviewId, v.minutes, v.deadline] },
  reminder: { name: 'partways_reminder', body: (v) => [v.interviewId, v.org, v.deadline] },
};

// What the person will read, for HR's preview of the message.
export function whatsappText(kind, v) {
  return kind === 'reminder'
    ? `Hi, a reminder that your PartWays exit interview (${v.interviewId}) for ${v.org} is open until ${v.deadline}. You can take part, or decline, using the button below.\n\n[Open my interview]`
    : `Your PartWays exit interview for ${v.org} is ready.\n\nInterview Id: ${v.interviewId}\nLength: about ${v.minutes} minutes, by voice or by typing\nOpen until: ${v.deadline}\n\nYour answers are de-identified before they are shared. Use the button below to open your interview.\n\n[Open my interview]`;
}

// Sends the approved template; the button opens https://partways.org/i/<token>.
export async function sendWhatsApp({ to, kind, values, token }) {
  const t = TEMPLATES[kind];
  if (!whatsappLive()) {
    console.log(`\n[PartWays] WhatsApp ${t.name} to ${to} (not sent: no WhatsApp number configured)\n${whatsappText(kind, values)}\n`);
    return { simulated: true };
  }
  const message = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/[^\d]/g, ''),
    type: 'template',
    template: {
      name: t.name,
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: t.body(values).map((text) => ({ type: 'text', text: String(text) })) },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: token }] },
      ],
    },
  };
  client ||= new SocialMessagingClient({});
  const r = await client.send(new SendWhatsAppMessageCommand({
    originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    message: new TextEncoder().encode(JSON.stringify(message)),
    metaApiVersion: process.env.WHATSAPP_META_API_VERSION || 'v23.0',
  }));
  return { simulated: false, messageId: r.messageId || null };
}
