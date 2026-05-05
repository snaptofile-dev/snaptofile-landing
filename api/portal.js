// api/portal.js
// Vercel serverless function — generates a Stripe Customer Portal URL
// so the user can manage their subscription (update card, cancel, view
// invoices, change billing email).
//
// Called from:
//   - "Manage subscription" button in the Pro app settings drawer (6C)
//   - "Update payment method" / "Renew" links in the past_due and
//     export_only banners (6B)
//
// Frontend POSTs here, receives { url }, then does location.href = url
// to send the user to Stripe's hosted portal page.
//
// Request:
//   POST /api/portal
//   Content-Type: application/json
//   { "license_key": "STF-XXXX-XXXX-XXXX-XXXX", "device_id": "<uuid>" }
//
// Responses:
//   200 OK { url }
//   400 Bad Request — malformed input
//   403 Forbidden — device not registered for this license
//   404 Not Found — license key doesn't exist, or no Stripe customer linked
//   500 Internal Server Error
//
// Notes:
//   - Subscription status is NOT gated here. Even canceled / past_due
//     users should be able to reach the portal to update their card or
//     download past invoices — that's exactly what the portal is for.
//   - Device check is the same shape as /api/validate: device_id must
//     be in the registered list. Prevents a leaked license_key from
//     being used to hijack someone else's billing settings.
//
// Required env vars:
//   STRIPE_SECRET_KEY     (already set from Chunk 1)
//   PORTAL_RETURN_URL     (NEW — where Stripe sends users after they're
//                          done in the portal, e.g. https://snaptofile.com/app/pro)
//   AIRTABLE_PAT, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID (already set)

import Stripe from 'stripe';
import { findByLicenseKey } from '../lib/airtable.js';
import { normalizeLicenseKey } from '../lib/license.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const required = [
    'STRIPE_SECRET_KEY',
    'PORTAL_RETURN_URL',
    'AIRTABLE_PAT',
    'AIRTABLE_BASE_ID',
    'AIRTABLE_TABLE_ID',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[portal] missing env vars:', missing.join(', '));
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const licenseKey = normalizeLicenseKey(body.license_key);
  const deviceId   = String(body.device_id || '').trim();

  if (!licenseKey) return res.status(400).json({ error: 'invalid_license_key' });
  if (!deviceId)   return res.status(400).json({ error: 'invalid_device_id' });

  let record;
  try {
    record = await findByLicenseKey(licenseKey);
  } catch (err) {
    console.error('[portal] airtable lookup failed:', err);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!record) return res.status(404).json({ error: 'license_not_found' });

  const fields = record.fields || {};

  // Device gate — must be registered to this license. Same shape as
  // /api/validate. Prevents a leaked license_key from being used to
  // hijack someone else's billing settings.
  const deviceList = parseDeviceList(fields.device_fingerprint);
  if (!deviceList.includes(deviceId)) {
    console.log(`[portal] refused ${licenseKey} — device not registered`);
    return res.status(403).json({
      error: 'device_not_registered',
      message: 'This device is not registered for this license. Please re-activate.',
    });
  }

  const customerId = fields.stripe_customer_id;
  if (!customerId) {
    console.error(`[portal] no stripe_customer_id on license ${licenseKey}`);
    return res.status(404).json({ error: 'no_stripe_customer' });
  }

  // Create the portal session
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: process.env.PORTAL_RETURN_URL,
    });
  } catch (err) {
    console.error('[portal] stripe portal session create failed:', err);
    return res.status(500).json({ error: 'portal_session_failed' });
  }

  console.log(`[portal] session created for ${licenseKey}`);
  return res.status(200).json({ url: session.url });
}

// ────────────────────────────────────────────────────────────
// Helpers (kept in sync with api/validate.js)
// ────────────────────────────────────────────────────────────

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function parseDeviceList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
