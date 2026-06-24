// api/reset-devices.js
// Self-service recovery for Pro browser/device activation slots.
//
// Request:
//   POST /api/reset-devices
//   Content-Type: application/json
//   { "license_key": "STF-XXXX-XXXX-XXXX-XXXX", "email": "customer@example.com" }
//
// Response:
//   200 OK { ok, devices_cleared, devices_used, devices_max, subscription_status, email }
//
// This endpoint intentionally does not issue a token. The Pro app clears local
// activation storage after a reset and sends the customer back through normal
// /api/activate, which records the current browser/device again.

import { findByLicenseKey, updateLicense } from '../lib/airtable.js';
import { normalizeLicenseKey } from '../lib/license.js';

const MAX_DEVICES = 3;
const RESETTABLE_STATUSES = new Set(['active', 'past_due', 'trialing']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const required = ['AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[reset-devices] missing env vars:', missing.join(', '));
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const licenseKey = normalizeLicenseKey(body.license_key);
  const email = normalizeEmail(body.email);

  if (!licenseKey) return res.status(400).json({ error: 'invalid_license_key' });
  if (!email) return res.status(400).json({ error: 'invalid_email' });

  let record;
  try {
    record = await findByLicenseKey(licenseKey);
  } catch (err) {
    console.error('[reset-devices] airtable lookup failed:', err);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!record) return res.status(404).json({ error: 'license_not_found' });

  const fields = record.fields || {};
  const status = fields.subscription_status || 'unknown';
  const recordEmail = normalizeEmail(fields.email);

  if (!RESETTABLE_STATUSES.has(status)) {
    return res.status(403).json({
      error: 'subscription_inactive',
      subscription_status: status,
    });
  }

  if (!recordEmail || recordEmail !== email) {
    return res.status(403).json({ error: 'email_mismatch' });
  }

  const existingList = parseDeviceList(fields.device_fingerprint);
  const nowIso = new Date().toISOString();

  try {
    await updateLicense(record.id, {
      device_fingerprint: '',
      last_validated_at: nowIso,
    });
  } catch (err) {
    console.error('[reset-devices] airtable update failed:', err);
    return res.status(500).json({ error: 'update_failed' });
  }

  console.log(`[reset-devices] cleared ${existingList.length} activation(s) for ${maskLicenseKey(licenseKey)}`);

  return res.status(200).json({
    ok: true,
    devices_cleared: existingList.length,
    devices_used: 0,
    devices_max: MAX_DEVICES,
    subscription_status: status,
    email: fields.email || null,
  });
}

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

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function parseDeviceList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function maskLicenseKey(key) {
  if (!key || key.length < 8) return 'STF-****';
  return `STF-****-${key.slice(-4)}`;
}
