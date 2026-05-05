// api/validate.js
// Vercel serverless function — re-validates an existing license/device pair
// and returns a refreshed JWT.
//
// Called by the Pro HTML in the background when the current token has ≤7
// days remaining. If the device is no longer registered (e.g. user
// deactivated from another device), this returns 403 and the app falls
// back to export-only mode on next reload.
//
// Request:
//   POST /api/validate
//   Content-Type: application/json
//   { "license_key": "STF-XXXX-XXXX-XXXX-XXXX", "device_id": "<uuid>" }
//
// Responses:
//   200 OK { token, expires_at, subscription_status, devices_used, devices_max }
//   400 Bad Request — malformed input
//   403 Forbidden — device not registered, or subscription canceled/unpaid
//   404 Not Found — license key doesn't exist
//   500 Internal Server Error
//
// Why a separate endpoint from /api/activate:
//   - /api/activate is allowed to grow the device list (up to N=3)
//   - /api/validate is read-only with respect to the device list — it will
//     never silently add a device. The client must call /api/activate
//     explicitly for that.
//   - This split prevents a stolen/leaked token from quietly registering a
//     new device by being replayed against /api/validate.
//
// Required env vars: same as /api/activate.

import { findByLicenseKey, updateLicense } from '../lib/airtable.js';
import { normalizeLicenseKey } from '../lib/license.js';
import { signLicenseToken, TOKEN_TTL_DAYS } from '../lib/jwt.js';

const MAX_DEVICES = 3;

// Statuses for which we'll re-issue a token. past_due is allowed (Stripe
// retry grace period — Pro app shows the soft yellow banner). Anything
// else means export-only mode.
const VALID_STATUSES = new Set(['active', 'past_due', 'trialing']);

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

  const required = ['LICENSE_PRIVATE_KEY', 'AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[validate] missing env vars:', missing.join(', '));
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
    console.error('[validate] airtable lookup failed:', err);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!record) return res.status(404).json({ error: 'license_not_found' });

  const fields = record.fields || {};
  const status = fields.subscription_status || 'unknown';

  // Status gate
  if (!VALID_STATUSES.has(status)) {
    console.log(`[validate] refused ${licenseKey} — status=${status}`);
    return res.status(403).json({
      error: 'subscription_inactive',
      subscription_status: status,
    });
  }

  // Device gate — read-only, must already be registered
  const deviceList = parseDeviceList(fields.device_fingerprint);
  if (!deviceList.includes(deviceId)) {
    console.log(`[validate] refused ${licenseKey} — device not registered`);
    return res.status(403).json({
      error: 'device_not_registered',
      message: 'This device is not registered for this license. Please re-activate.',
    });
  }

  // Update last_validated_at — diagnostic, not load-bearing
  try {
    await updateLicense(record.id, {
      last_validated_at: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal — log but still issue the token. The whole point of an
    // offline-tolerant license is that occasional Airtable hiccups don't
    // lock users out.
    console.warn('[validate] last_validated_at update failed (non-fatal):', err.message);
  }

  // Sign refreshed token
  const activatedAt = fields.activated_at || new Date().toISOString();
  const email       = fields.email || null;

  let token;
  try {
    token = await signLicenseToken({
      licenseKey,
      deviceId,
      subscriptionStatus: status,
      activatedAt,
      email,
    });
  } catch (err) {
    console.error('[validate] token signing failed:', err);
    return res.status(500).json({ error: 'signing_failed' });
  }

  return res.status(200).json({
    token,
    expires_at:          isoSecondsFromNow(TOKEN_TTL_DAYS * 86400),
    subscription_status: status,
    devices_used:        deviceList.length,
    devices_max:         MAX_DEVICES,
    activated_at:        activatedAt,
    email,
  });
}

// ────────────────────────────────────────────────────────────
// Helpers (kept in sync with api/activate.js)
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

function isoSecondsFromNow(secs) {
  return new Date(Date.now() + secs * 1000).toISOString();
}
