// api/stripe-webhook.js
// Vercel serverless function — receives Stripe webhook events and turns them
// into license records + transactional emails.
//
// Events handled:
//   checkout.session.completed     -> create license, write Airtable, send welcome email
//   customer.subscription.updated  -> update Airtable (status, current_period_end)
//   customer.subscription.deleted  -> set Airtable status to "canceled"
//   invoice.payment_failed         -> set Airtable status to "past_due"
//                                    (Stripe sends the dunning email itself)
//
// Required env vars:
//   STRIPE_SECRET_KEY        sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET    whsec_...   (from Stripe dashboard → Webhooks → endpoint signing secret)
//   AIRTABLE_PAT             personal access token, scoped to the licenses base
//   AIRTABLE_BASE_ID         appo9ngXEGfoHyOAw
//   AIRTABLE_TABLE_ID        tblk3l1Bb2D3SkIWr
//   RESEND_API_KEY           re_...
//   PRO_DOWNLOAD_URL         e.g. https://snaptofile.com/app/snaptofile-pro.html
//
// IMPORTANT: bodyParser must be disabled so Stripe's signature can be
// verified against the raw request body. If Vercel ever silently re-enables
// it, signature verification will fail with a confusing error — the bodyParser:
// false config below is load-bearing.
//
// Vercel will detect this config and pass us the raw stream.

import Stripe from 'stripe';
import { generateLicenseKey } from '../lib/license.js';
import { findBySubscriptionId, createLicense, updateLicense } from '../lib/airtable.js';
import { sendEmail } from '../lib/email.js';
import { buildWelcomeEmail } from '../lib/email-template.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Read the raw request body as a Buffer. Required for signature verification.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Defensive: catch missing env vars at the top so the failure surfaces here
  // instead of mid-handler. We don't include the values in the response.
  const requiredEnv = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'AIRTABLE_PAT',
    'AIRTABLE_BASE_ID',
    'AIRTABLE_TABLE_ID',
    'RESEND_API_KEY',
    'PRO_DOWNLOAD_URL',
  ];
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[webhook] missing env vars:', missing.join(', '));
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // 1) Verify the signature using the raw body.
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    console.error('[webhook] missing stripe-signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }

  let rawBody, event;
  try {
    rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`[webhook] received ${event.type} (${event.id})`);

  // 2) Dispatch on event type. Each handler is responsible for being idempotent
  //    so Stripe's automatic retries don't create duplicate records.
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      default:
        // Unhandled events are not errors — Stripe sends many we don't care about.
        console.log(`[webhook] ignoring ${event.type}`);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Log loudly and return 500 so Stripe will retry the delivery.
    console.error(`[webhook] handler error for ${event.type}:`, err);
    return res.status(500).json({ error: 'Handler failed', message: err.message });
  }
}

// ────────────────────────────────────────────────────────────
// Event handlers
// ────────────────────────────────────────────────────────────

/**
 * checkout.session.completed
 * The customer has paid (or trial-started) and a subscription now exists.
 * Generate a license key, persist to Airtable, send the welcome email.
 *
 * Idempotent: if a record with this subscription_id already exists, we
 * re-send the welcome email but do not generate a new key. (This trades
 * a possible duplicate email for guaranteed delivery, since Stripe
 * occasionally redelivers events.)
 */
async function handleCheckoutCompleted(session) {
  const subscriptionId = session.subscription;
  const customerId     = session.customer;
  const customerEmail  = session.customer_details?.email || session.customer_email;

  if (!subscriptionId) {
    console.warn('[webhook] checkout.session.completed missing subscription — likely a one-time payment, ignoring');
    return;
  }
  if (!customerEmail) {
    throw new Error(`No email on checkout session ${session.id}`);
  }

  // Idempotency check — has this subscription already been processed?
  const existing = await findBySubscriptionId(subscriptionId);
  if (existing) {
    console.log(`[webhook] subscription ${subscriptionId} already in Airtable as ${existing.fields.license_key} — re-sending email only`);
    await sendWelcomeEmail({
      to: customerEmail,
      licenseKey: existing.fields.license_key,
    });
    return;
  }

  // Fetch the subscription to get period_end and the price ID.
  // (The session's line_items aren't included by default; the subscription
  // object has the recurring item we need.)
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item         = subscription.items.data[0];
  const priceId      = item?.price?.id || null;
  const periodEnd    = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  const licenseKey = generateLicenseKey();
  const nowIso     = new Date().toISOString();

  await createLicense({
    license_key:            licenseKey,
    email:                  customerEmail,
    stripe_customer_id:     customerId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id:        priceId,
    plan:                   'Pro',
    subscription_status:    subscription.status,  // typically "active" or "trialing"
    current_period_end:     periodEnd,
    created_at:             nowIso,
  });

  console.log(`[webhook] created license ${licenseKey} for ${customerEmail}`);

  await sendWelcomeEmail({
    to: customerEmail,
    licenseKey,
  });
}

/**
 * customer.subscription.updated
 * Renewal, plan change, status change. We mirror status + current_period_end.
 */
async function handleSubscriptionUpdated(subscription) {
  const record = await findBySubscriptionId(subscription.id);
  if (!record) {
    // Common case: the .updated event arrives before .completed has finished
    // processing. Stripe will retry; let's tell it to do so.
    throw new Error(`No Airtable record for subscription ${subscription.id} (yet?)`);
  }

  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  await updateLicense(record.id, {
    subscription_status: subscription.status,
    current_period_end:  periodEnd,
  });
  console.log(`[webhook] updated ${record.fields.license_key} -> status=${subscription.status}`);
}

/**
 * customer.subscription.deleted
 * Subscription fully canceled (end of grace period). Mark the license canceled.
 * The Pro app will fall into export-only mode on next /api/validate (Chunk 5).
 */
async function handleSubscriptionDeleted(subscription) {
  const record = await findBySubscriptionId(subscription.id);
  if (!record) {
    console.warn(`[webhook] subscription.deleted but no Airtable record for ${subscription.id} — skipping`);
    return;
  }
  await updateLicense(record.id, {
    subscription_status: 'canceled',
  });
  console.log(`[webhook] canceled ${record.fields.license_key}`);
}

/**
 * invoice.payment_failed
 * Card was declined. Stripe handles the customer-facing dunning email itself
 * (we toggled that on in Chunk 1). We just mirror the status.
 */
async function handlePaymentFailed(invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return; // Non-subscription invoice; ignore.

  const record = await findBySubscriptionId(subscriptionId);
  if (!record) {
    console.warn(`[webhook] payment_failed but no Airtable record for ${subscriptionId} — skipping`);
    return;
  }
  await updateLicense(record.id, {
    subscription_status: 'past_due',
  });
  console.log(`[webhook] flagged past_due ${record.fields.license_key}`);
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

async function sendWelcomeEmail({ to, licenseKey }) {
  const { subject, html, text } = buildWelcomeEmail({
    licenseKey,
    downloadUrl:   process.env.PRO_DOWNLOAD_URL,
    customerEmail: to,
  });
  await sendEmail({ to, subject, html, text });
  console.log(`[webhook] sent welcome email to ${to}`);
}
