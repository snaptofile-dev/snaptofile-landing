// lib/airtable.js
// Thin wrapper around the Airtable REST API for the SnapToFile Licenses base.
// We use raw fetch rather than the airtable npm package to avoid an extra
// dependency on Vercel's bundle size and to make error handling explicit.
//
// Required env vars:
//   AIRTABLE_PAT       — personal access token, scoped to data.records:read+write on the licenses base
//   AIRTABLE_BASE_ID   — appo9ngXEGfoHyOAw
//   AIRTABLE_TABLE_ID  — tblk3l1Bb2D3SkIWr (Licenses)
//
// Field IDs (frozen — schema validated 2026-04-27):
//   license_key            fld0NsP0e6ukxVdts   (primary)
//   email                  fldMXXzGQOD4v097L
//   stripe_customer_id     fldbYS7jQlOvFwlRC
//   stripe_subscription_id fldlODdNjghkBvYVN
//   stripe_price_id        fldsbVkQ7EoAR7Gbi
//   plan                   fldymzTXSKdOuBGV6   (singleSelect)
//   subscription_status    fldrDWqKq7goGmYlr   (singleSelect)
//   current_period_end     fld0vYALJEt55PXUj   (dateTime)
//   activated_at           fldhns2RQdjBWHW0J   (dateTime — null until /api/activate)
//   device_fingerprint     fldkNjksH4aOjhKRY
//   last_validated_at      fldNkczN6CEXR4kia   (dateTime — null until first /api/validate)
//   notes                  fldkLYOavmsDeL65x   (multilineText)
//   created_at             fldqgLC6ABb3GE7tl   (dateTime)

const FIELDS = {
  license_key:            'fld0NsP0e6ukxVdts',
  email:                  'fldMXXzGQOD4v097L',
  stripe_customer_id:     'fldbYS7jQlOvFwlRC',
  stripe_subscription_id: 'fldlODdNjghkBvYVN',
  stripe_price_id:        'fldsbVkQ7EoAR7Gbi',
  plan:                   'fldymzTXSKdOuBGV6',
  subscription_status:    'fldrDWqKq7goGmYlr',
  current_period_end:     'fld0vYALJEt55PXUj',
  activated_at:           'fldhns2RQdjBWHW0J',
  device_fingerprint:     'fldkNjksH4aOjhKRY',
  last_validated_at:      'fldNkczN6CEXR4kia',
  notes:                  'fldkLYOavmsDeL65x',
  created_at:             'fldqgLC6ABb3GE7tl',
};

function baseUrl() {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;
}

function authHeaders() {
  return {
    'Authorization': `Bearer ${process.env.AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Find a license record by Stripe subscription ID. Returns the Airtable record
 * (with .id and .fields) or null if not found.
 *
 * Used for idempotency on checkout.session.completed, and as the lookup path
 * for subscription.updated / subscription.deleted / invoice.payment_failed.
 */
export async function findBySubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  // Airtable filterByFormula needs the field name (not ID) inside {} braces.
  // We use the field name "stripe_subscription_id" because filterByFormula
  // resolves names case-sensitively at query time. Escape any single quotes
  // in the value defensively, though Stripe IDs never contain them.
  const escaped = subscriptionId.replace(/'/g, "\\'");
  const formula = encodeURIComponent(`{stripe_subscription_id} = '${escaped}'`);
  const url = `${baseUrl()}?filterByFormula=${formula}&maxRecords=1`;

  const res = await fetch(url, { method: 'GET', headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable findBySubscriptionId failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return (data.records && data.records[0]) || null;
}

/**
 * Create a new license record. Uses typecast:true so any new singleSelect
 * value (e.g. a Stripe status we haven't seen before) auto-creates as an
 * option rather than failing the webhook.
 *
 * Field values: pass plain strings for singleSelect (e.g. "active", "Pro"),
 * ISO 8601 strings for dateTime fields.
 */
export async function createLicense(fields) {
  const body = {
    records: [{
      fields: mapFieldNamesToIds(fields),
    }],
    typecast: true,
  };
  const res = await fetch(baseUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable createLicense failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.records[0];
}

/**
 * Update an existing license record by its Airtable record ID.
 */
export async function updateLicense(recordId, fields) {
  const body = {
    fields: mapFieldNamesToIds(fields),
    typecast: true,
  };
  const res = await fetch(`${baseUrl()}/${recordId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable updateLicense failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Translate a fields object using human-readable keys (e.g. "license_key")
 * into the field-ID form Airtable's API requires (e.g. "fld0NsP0e6ukxVdts").
 * Throws on unknown keys to catch typos at runtime.
 */
function mapFieldNamesToIds(fields) {
  const out = {};
  for (const [name, value] of Object.entries(fields)) {
    const id = FIELDS[name];
    if (!id) throw new Error(`Unknown Airtable field: ${name}`);
    out[id] = value;
  }
  return out;
}

export { FIELDS };
