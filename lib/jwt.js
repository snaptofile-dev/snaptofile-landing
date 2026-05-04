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

import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';

const ALG = 'EdDSA';

// JWT validity window. Decided 2026-04-27 in the Stripe Plan §8:
//   - 14-day token lifetime
//   - Background re-validation triggers when ≤7 days remain
// Tracked here as constants so the activate/validate endpoints can't drift.
export const TOKEN_TTL_DAYS = 14;
export const REVALIDATE_THRESHOLD_DAYS = 7;

/**
 * Cache the imported private key across warm Lambda invocations. Importing
 * a PEM is cheap but not free, and Vercel keeps function instances warm.
 */
let _privateKey = null;
async function getPrivateKey() {
  if (_privateKey) return _privateKey;
  const pem = process.env.LICENSE_PRIVATE_KEY;
  if (!pem) throw new Error('LICENSE_PRIVATE_KEY env var is not set');
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
  const key = await importSPKI(publicPem, ALG);
  const { payload } = await jwtVerify(jwt, key, {
    issuer:   'snaptofile.com',
    audience: 'snaptofile-pro',
  });
  return payload;
}
