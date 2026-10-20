// Interview credits: 3 free, then packs bought with Stripe Checkout.
// With no STRIPE_SECRET_KEY the purchase is simulated and labelled as a test purchase.
// Use a test-mode key (sk_test_…) until the account is ready to take payments.
import Stripe from 'stripe';
import { route, fail } from '../lib/http.js';
import { store } from '../lib/data.js';
import { newId } from '../lib/ids.js';
import { getStore } from '../store/index.js';
import { PACKS, FREE_CREDITS, creditSummary, grantPurchase } from '../domain/workspaces.js';

let client;
const stripe = () => (process.env.STRIPE_SECRET_KEY ? (client ||= new Stripe(process.env.STRIPE_SECRET_KEY)) : null);
const stripeMode = () => (!process.env.STRIPE_SECRET_KEY ? 'simulated' : process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test');

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

route('GET', '/api/hr/billing', async () => {
  const summary = await creditSummary(store());
  return { ...summary, packs: Object.values(PACKS), freeCredits: FREE_CREDITS, payments: stripeMode() };
}, { auth: true });

route('POST', '/api/hr/billing/checkout', async (req) => {
  await ownWorkspace();
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
  const { entry, duplicate } = await grantPurchase(store(), { ref: session.id, packId: session.metadata.packId, amountUsd: session.amount_total / 100 });
  return { status: 'paid', entry, duplicate, ...(await creditSummary(store())) };
}, { auth: true });

route('POST', '/api/hr/billing/simulate', async (req) => {
  await ownWorkspace();
  if (stripe()) fail(409, 'Payments are configured, so purchases go through Stripe Checkout.');
  if (!PACKS[req.body?.pack]) fail(400, 'Choose a credit pack.');
  const { entry } = await grantPurchase(store(), { ref: newId('sim'), packId: req.body.pack, simulated: true });
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
      await grantPurchase(getStore(orgId), { ref: s.id, packId: s.metadata.packId, amountUsd: s.amount_total / 100 });
    }
  }
  return { received: true };
});
