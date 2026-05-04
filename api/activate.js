// api/activate.js
// Vercel serverless function — activates a license key on a device.
//
// Request:
//   POST /api/activate
//   Content-Type: application/json
//   { "license_key": "STF-XXXX-XXXX-XXXX-XXXX", "device_id": "<uuid>" }
//
// Responses:
//   200 OK { token, expires_at, subscription_status, devices_used, devices_max }
//   400 Bad Request — malformed key, missing fields
//   404 Not Found — key shape valid but not in Airtable
//   403 Forbidden — subscription canceled/unpaid/incomplete (export-only mode)
//   409 Conflict — N=3 device limit reached, includes existing device_ids
//   500 Internal Server Error — unhandled failure
//
// Multi-device policy (Stripe Plan §8, settled 2026-04-27):
//   - Up to N=3 devices per license
//   - device_id is a stable localStorage UUID, generated once on first
//     activation by the Pro HTML (NOT a browser-fingerprint hash — clearing
//     storage = new device, accepted as user action)
//   - 4th activation returns 409 with the existing device list; user must
//     deactivate one via the in-app "Deactivate this device" button (Chunk 6)
//   - Manual reset for support escalations: clear device_fingerprint field
//     in Airtable directly. Self-service reset is in Future_Planning.
//
// JWT validity (Stripe Plan §8, settled 2026-04-27):
//   - 14-day token TTL
//   - Pro HTML re-validates when ≤7 days remain
//
// Required env vars:
//   LICENSE_PRIVATE_KEY    Ed25519 PKCS#8 PEM
//   AIRTABLE_PAT
//   AIRTABLE_BASE_ID
//   AIRTABLE_TABLE_ID

import { findByLicenseKey, updateLicense } from '../lib/airtable.js';
import { normalizeLicenseKey } from '../lib/license.js';
import { signLicenseToken, TOKEN_TTL_DAYS } from '../lib/jwt.js';

const MAX_DEVICES = 3;

// Statuses that allow activation. past_due is allowed because the user is in
// the Stripe retry grace period — the Pro HTML will show the soft yellow
// banner on those tokens, but full app access continues.
const ACTIVATABLE_STATUSES = new Set(['active', 'past_due', 'trialing']);

export default async function handler(req, res) {
  // CORS — the Pro HTML is served from /app/pro on the same origin, so this
  // is mostly belt-and-suspenders. Allow JSON POSTs only.
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

  // Defensive env-var check — fail loudly here instead of mid-handler.
  const required = ['LICENSE_PRIVATE_KEY', 'AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[activate] missing env vars:', missing.join(', '));
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // 1) Parse + validate input
  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const rawKey   = body.license_key;
  const deviceId = String(body.device_id || '').trim();

  const licenseKey = normalizeLicenseKey(rawKey);
  if (!licenseKey) {
    return res.status(400).json({ error: 'invalid_license_key' });
  }
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return res.status(400).json({ error: 'invalid_device_id' });
  }

  // 2) Look up the license
  let record;
  try {
    record = await findByLicenseKey(licenseKey);
  } catch (err) {
    console.error('[activate] airtable lookup failed:', err);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!record) {
    return res.status(404).json({ error: 'license_not_found' });
  }

  const fields = record.fields || {};
  const status = fields.subscription_status || 'unknown';

  // 3) Status gate — must be active/past_due/trialing to activate
  if (!ACTIVATABLE_STATUSES.has(status)) {
    console.log(`[activate] refused ${licenseKey} — status=${status}`);
    return res.status(403).json({
      error: 'subscription_inactive',
      subscription_status: status,
      message: 'This subscription is not currently active. Please renew via the customer portal.',
    });
  }

  // 4) Device-list logic
  // device_fingerprint stores a comma-separated list of UUIDs. Empty/null
  // means no devices activated yet.
  const existingList = parseDeviceList(fields.device_fingerprint);

  let updatedList;
  let firstActivation = false;

  if (existingList.includes(deviceId)) {
    // Already activated on this device — legitimate re-issue (e.g. token
    // wiped by browser, fresh install on the same machine). Don't increment.
    updatedList = existingList;
    console.log(`[activate] re-activation for ${licenseKey} on existing device`);
  } else if (existingList.length >= MAX_DEVICES) {
    // 5) Limit hit — return 409 with the device list so the user knows.
    return res.status(409).json({
      error:        'device_limit_reached',
      devices_used: existingList.length,
      devices_max:  MAX_DEVICES,
      device_ids:   existingList,
      message:      `This license is already activated on ${existingList.length} devices (max ${MAX_DEVICES}). Deactivate one of those devices to add this one.`,
    });
  } else {
    // 6) New device, room available — append
    updatedList = [...existingList, deviceId];
    firstActivation = existingList.length === 0;
    console.log(`[activate] new device ${maskDeviceId(deviceId)} for ${licenseKey} (${updatedList.length}/${MAX_DEVICES})`);
  }

  // 7) Persist activation. activated_at is set on first-ever activation only.
  const nowIso = new Date().toISOString();
  const updates = {
    device_fingerprint: serializeDeviceList(updatedList),
    last_validated_at:  nowIso,
  };
  if (firstActivation) updates.activated_at = nowIso;

  try {
    await updateLicense(record.id, updates);
  } catch (err) {
    console.error('[activate] airtable update failed:', err);
    return res.status(500).json({ error: 'update_failed' });
  }

  // 8) Sign + return the token
  const activatedAt = firstActivation ? nowIso : (fields.activated_at || nowIso);
  let token;
  try {
    token = await signLicenseToken({
      licenseKey,
      deviceId,
      subscriptionStatus: status,
      activatedAt,
    });
  } catch (err) {
    console.error('[activate] token signing failed:', err);
    return res.status(500).json({ error: 'signing_failed' });
  }

  return res.status(200).json({
    token,
    expires_at:          isoSecondsFromNow(TOKEN_TTL_DAYS * 86400),
    subscription_status: status,
    devices_used:        updatedList.length,
    devices_max:         MAX_DEVICES,
    activated_at:        activatedAt,
  });
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

async function readJsonBody(req) {
  // Vercel parses JSON automatically when Content-Type is application/json,
  // but only when bodyParser is enabled (the default). The webhook disables
  // it; this endpoint leaves it on.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // Fallback: read the raw stream
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

function serializeDeviceList(list) {
  return list.join(',');
}

function maskDeviceId(id) {
  // For logging only — don't leak full device IDs to logs.
  if (!id || id.length < 12) return '***';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function isoSecondsFromNow(secs) {
  return new Date(Date.now() + secs * 1000).toISOString();
}
