// lib/jwt.js
// Ed25519 JWT signing for SnapToFile Pro license tokens.
//
// The activation and re-validation endpoints (api/activate.js, api/validate.js)
// hand the user a signed JWT. The Pro HTML embeds the matching public key and
// verifies the signature locally using Web Crypto on every load. As long as
// the JWT's valid_until is in the future and the signature checks out, the
// app trusts it without contacting the server.
//
// Why Ed25519: small keys, fast verification, modern crypto. The JOSE
// algorithm name is "EdDSA" — that's correct, EdDSA is the JWT label that
// covers Ed25519.
//
// Why jose: handles PEM parsing, base64url, signature bytes correctly. The
// equivalent native-crypto code is ~30 lines per side and easy to get
// subtly wrong (encoding mismatches, header struct details, etc.).
//
// Required env vars:
//   LICENSE_PRIVATE_KEY   PKCS#8 PEM, generated locally and pasted into Vercel
//                          as a Sensitive variable on Production+Preview.
//
// The corresponding PUBLIC key lives in /One_Time_Use/STF_PUBLIC_KEY.txt and
// gets embedded into the Pro HTML in Chunk 6.
//
// PEM normalization note (added 2026-05-04):
// Vercel's Sensitive env var input flattens line breaks when pasted from
// clipboard, producing a single-line PEM that jose's importPKCS8 rejects
// with "must be PKCS#8 formatted string". normalizePemString() rebuilds
// the canonical multi-line PEM structure before importPKCS8 sees it.

import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';

const ALG = 'EdDSA';

// JWT validity window. Decided 2026-04-27 in the Stripe Plan §8:
//   - 14-day token lifetime
//   - Background re-validation triggers when ≤7 days remain
// Tracked here as constants so the activate/validate endpoints can't drift.
export const TOKEN_TTL_DAYS = 14;
export const REVALIDATE_THRESHOLD_DAYS = 7;

/**
 * Repair a PEM string whose line breaks may have been stripped by the host
 * environment (e.g. Vercel's Sensitive env var input). If the input already
 * has proper line breaks, it passes through unchanged. If newlines were
 * flattened to spaces or removed entirely, this rebuilds the canonical
 * multi-line PEM structure that PKCS#8 parsers require.
 *
 * Strategy:
 *   1. Find the BEGIN and END marker lines
 *   2. Extract everything between them as the base64 body
 *   3. Strip all whitespace from the body (it might have spaces or newlines)
 *   4. Re-wrap the body at 64 chars/line per RFC 7468
 *   5. Reassemble with \n separators
 */
function normalizePemString(pem) {
  if (typeof pem !== 'string' || pem.length === 0) return pem;

  // Match BEGIN/END markers in any line-break configuration. The label
  // (e.g. "PRIVATE KEY") between BEGIN/END must match — we use a backref.
  const re = /-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/;
  const match = pem.match(re);
  if (!match) {
    // No recognizable PEM structure — return as-is and let the underlying
    // parser produce its native error message.
    return pem;
  }

  const label = match[1];
  const body  = match[2].replace(/\s+/g, ''); // collapse all whitespace

  // Re-wrap base64 body at 64 chars/line (RFC 7468 standard width)
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;

  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

/**
 * Cache the imported private key across warm Lambda invocations. Importing
 * a PEM is cheap but not free, and Vercel keeps function instances warm.
 */
let _privateKey = null;
async function getPrivateKey() {
  if (_privateKey) return _privateKey;
  const raw = process.env.LICENSE_PRIVATE_KEY;
  if (!raw) throw new Error('LICENSE_PRIVATE_KEY env var is not set');
  const pem = normalizePemString(raw);
  _privateKey = await importPKCS8(pem, ALG);
  return _privateKey;
}

/**
 * Sign a license token. Returns a JWT string.
 *
 * Payload structure (what the Pro HTML will read):
 *   {
 *     license_key:         "STF-XXXX-XXXX-XXXX-XXXX",
 *     device_id:           "uuid-from-localStorage",
 *     subscription_status: "active" | "past_due" | "canceled" | ...,
 *     activated_at:        ISO 8601 string (first activation time),
 *     iat:                 unix seconds (issued-at, set by jose),
 *     exp:                 unix seconds (issued-at + 14 days, set by jose)
 *   }
 *
 * The Pro HTML treats `exp` as the canonical expiry and compares
 * `subscription_status` to decide between active / past_due / export-only.
 */
export async function signLicenseToken({
  licenseKey,
  deviceId,
  subscriptionStatus,
  activatedAt,
}) {
  if (!licenseKey)         throw new Error('signLicenseToken: licenseKey required');
  if (!deviceId)           throw new Error('signLicenseToken: deviceId required');
  if (!subscriptionStatus) throw new Error('signLicenseToken: subscriptionStatus required');
  if (!activatedAt)        throw new Error('signLicenseToken: activatedAt required');

  const key = await getPrivateKey();

  return await new SignJWT({
    license_key:         licenseKey,
    device_id:           deviceId,
    subscription_status: subscriptionStatus,
    activated_at:        activatedAt,
  })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_DAYS}d`)
    .setIssuer('snaptofile.com')
    .setAudience('snaptofile-pro')
    .sign(key);
}

/**
 * Server-side verification helper. The Pro HTML does its own verification
 * client-side (Chunk 6), but this is useful for debugging and tests.
 *
 * Pass a PEM-format public key — typically read from disk during local dev.
 */
export async function verifyLicenseTokenWithPublicPem(jwt, publicPem) {
  const key = await importSPKI(normalizePemString(publicPem), ALG);
  const { payload } = await jwtVerify(jwt, key, {
    issuer:   'snaptofile.com',
    audience: 'snaptofile-pro',
  });
  return payload;
}
