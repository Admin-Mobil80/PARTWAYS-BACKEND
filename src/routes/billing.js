// Interview credits: 3 free, then packs bought with Stripe Checkout.
// With no STRIPE_SECRET_KEY the purchase is simulated and labelled as a test purchase.
// Use a test-mode key (sk_test_…) until the account is ready to take payments.
import Stripe from 'stripe';
import { route, fail } from '../lib/http.js';
import { store, nowIso } from '../lib/data.js';
import { newId } from '../lib/ids.js';
import { getStore } from '../store/index.js';
import { PACKS, FREE_CREDITS, creditSummary, grantPurchase } from '../domain/workspaces.js';
import { sendEmail } from '../lib/mailer.js';

let client;
const stripe = () => (process.env.STRIPE_SECRET_KEY ? (client ||= new Stripe(process.env.STRIPE_SECRET_KEY)) : null);
// Live secret (sk_live_) and restricted (rk_live_) keys both take real payments.
// Self-service buying can be switched off while pricing is decided; credits are
// then added by the PartWays team from the BMS.
export const selfServeCredits = () => process.env.SELF_SERVE_CREDITS !== '0';
const contactEmail = () => process.env.CREDITS_CONTACT_EMAIL || null;
const requireSelfServe = () => {
  if (!selfServeCredits()) fail(403, 'Credits are added by PartWays. Use Request more credits on the Credits and billing page.', { code: 'credits_by_partways' });
};

const stripeMode = () => (!process.env.STRIPE_SECRET_KEY ? 'simulated' : /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY.trim()) ? 'live' : 'test');
export { stripeMode };

function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  if (req.headers?.origin) return req.headers.origin;
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost:8787';
  return `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
}

async function ownWorkspace() {
  const org = await store().get('org', 'org');
  if (org?.demo) fail(409, 'The demonstration workspace has unlimited credits. Switch to your own workspace to buy credits.');
  return org;
}

// The organisation's open request for credits, if any (kept in the global store for the BMS).
async function openRequest(orgId) {
  const all = await getStore('global').list('creditrequest');
  return all.filter((r) => r.orgId === orgId && r.status === 'open').sort((a, b) => b.at.localeCompare(a.at))[0] || null;
}

route('GET', '/api/hr/billing', async (req) => {
  const summary = await creditSummary(store());
  if (!selfServeCredits()) {
    const request = req.user?.orgId ? await openRequest(req.user.orgId) : null;
    return { ...summary, freeCredits: FREE_CREDITS, selfServe: false, request: request && { credits: request.credits, note: request.note, at: request.at, by: request.by } };
  }
  return { ...summary, packs: Object.values(PACKS), freeCredits: FREE_CREDITS, payments: stripeMode(), selfServe: true };
}, { auth: true });

// While credits are added by PartWays, organisations ask for more here. One open
// request per organisation: asking again updates it. The PartWays team is emailed
// and sees it in the BMS, where adding credits closes it.
route('POST', '/api/hr/billing/request', async (req) => {
  const org = await ownWorkspace();
  if (selfServeCredits()) fail(409, 'Credits can be bought on this page.');
  const raw = req.body?.credits;
  const credits = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  if (credits !== null && (!Number.isInteger(credits) || credits < 1 || credits > 1000)) fail(400, 'Enter a whole number of credits between 1 and 1,000, or leave it empty.');
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const g = getStore('global');
  const existing = await openRequest(req.user.orgId);
  const request = {
    ...(existing || { id: `${req.user.orgId}_${newId('crq')}`, orgId: req.user.orgId, status: 'open' }),
    orgName: org?.name || '', by: req.user.email, credits, note, at: nowIso(),
  };
  await g.put('creditrequest', request);
  const to = contactEmail();
  if (to) {
    const lines = [
      `${request.orgName} has asked for ${credits ? `${credits} more credits` : 'more credits'}.`,
      `Requested by: ${request.by}`,
      `Current balance: ${(await creditSummary(store())).balance}`,
      note ? `Note: ${note}` : null,
      '', 'Add credits from the BMS:',
    ].filter((x) => x !== null).join('\n');
    try {
      await sendEmail({ to, subject: `Credit request: ${request.orgName}`, text: lines, link: `https://bms.partways.org/#/orgs/${request.orgId}`, cta: 'Open in the BMS' });
    } catch (err) { console.error('Credit request email failed', err); }
  }
  return { request: { credits: request.credits, note: request.note, at: request.at, by: request.by }, updated: !!existing };
}, { auth: true });

route('POST', '/api/hr/billing/checkout', async (req) => {
  await ownWorkspace();
  requireSelfServe();
  const pack = PACKS[req.body?.pack];
  if (!pack) fail(400, 'Choose a credit pack.');
  if (!stripe()) return { mode: 'simulated', pack: pack.id };
  const origin = siteOrigin(req);
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd', unit_amount: pack.usd * 100,
        product_data: { name: `PartWays interview credits × ${pack.credits}`, description: '1 credit = 1 interview invitation' },
      },
    }],
    client_reference_id: req.user.orgId,
    metadata: { orgId: req.user.orgId, packId: pack.id },
    customer_email: req.user.email,
    success_url: `${origin}/hr/#/billing?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/hr/#/billing?cancelled=1`,
  });
  return { mode: stripeMode(), url: session.url };
}, { auth: true });

// Called when Stripe sends the buyer back. The webhook grants the same purchase; whichever arrives first wins.
route('POST', '/api/hr/billing/confirm', async (req) => {
  await ownWorkspace();
  if (!stripe()) fail(409, 'Payments are not configured.');
  const id = String(req.body?.sessionId || '');
  if (!id.startsWith('cs_')) fail(400, 'Unknown checkout.');
  const session = await stripe().checkout.sessions.retrieve(id);
  if (session.metadata?.orgId !== req.user.orgId) fail(403, 'This checkout belongs to another workspace.');
  if (session.payment_status !== 'paid') return { status: 'pending', ...(await creditSummary(store())) };
  const { entry, duplicate } = await grantPurchase(store(), { ref: session.id, packId: session.metadata.packId, amountUsd: session.amount_total / 100, by: req.user.email });
  return { status: 'paid', entry, duplicate, ...(await creditSummary(store())) };
}, { auth: true });

route('POST', '/api/hr/billing/simulate', async (req) => {
  await ownWorkspace();
  requireSelfServe();
  if (stripe()) fail(409, 'Payments are configured, so purchases go through Stripe Checkout.');
  if (!PACKS[req.body?.pack]) fail(400, 'Choose a credit pack.');
  const { entry } = await grantPurchase(store(), { ref: newId('sim'), packId: req.body.pack, simulated: true, by: req.user.email });
  return { entry, ...(await creditSummary(store())) };
}, { auth: true });

route('POST', '/api/stripe/webhook', async (req) => {
  if (!stripe() || !process.env.STRIPE_WEBHOOK_SECRET) fail(404, 'Not configured.');
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.rawBody || '', req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    fail(400, 'Invalid signature.');
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    const orgId = s.metadata?.orgId;
    if (s.payment_status === 'paid' && orgId && PACKS[s.metadata?.packId] && (await getStore('global').get('org', orgId))) {
      await grantPurchase(getStore(orgId), { ref: s.id, packId: s.metadata.packId, amountUsd: s.amount_total / 100, by: s.customer_details?.email || s.customer_email || null });
    }
  }
  return { received: true };
});
