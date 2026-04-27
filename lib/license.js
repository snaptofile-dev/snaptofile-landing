// lib/license.js
// License key generation for SnapToFile Pro.
//
// Format: STF-XXXX-XXXX-XXXX-XXXX (16 random characters in 4 groups of 4)
// Alphabet: 32 characters, excludes 0, 1, I, O for readability.
//   2 3 4 5 6 7 8 9 A B C D E F G H J K L M N P Q R S T U V W X Y Z
//
// Entropy: 32^16 = 1.21 × 10^24 possible keys. At 1B keys issued, collision
// probability is still ~4 × 10^-7. We do NOT add a per-issue collision check
// against Airtable — for our scale that's overkill and adds latency. If the
// product hits 100K+ subscribers we should revisit.

import { randomBytes } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALPHABET_LEN = ALPHABET.length; // 32

/**
 * Generate a single license key in the format STF-XXXX-XXXX-XXXX-XXXX.
 * Uses crypto.randomBytes for cryptographic strength (not Math.random, which
 * is predictable and unsuitable for any security-adjacent use).
 */
export function generateLicenseKey() {
  // 16 random bytes → 16 alphabet characters. We use the byte value mod 32
  // which is unbiased because 256 is divisible by 32.
  const bytes = randomBytes(16);
  let chars = '';
  for (let i = 0; i < 16; i++) {
    chars += ALPHABET[bytes[i] % ALPHABET_LEN];
  }
  return `STF-${chars.slice(0,4)}-${chars.slice(4,8)}-${chars.slice(8,12)}-${chars.slice(12,16)}`;
}

/**
 * Validate a license key's shape (not its existence in the database).
 * Used by /api/activate and /api/validate (Chunk 5) to fail fast on malformed
 * input before hitting Airtable.
 */
export function isValidLicenseShape(key) {
  if (typeof key !== 'string') return false;
  // Normalize: uppercase, strip whitespace. Customers will type these.
  const normalized = key.trim().toUpperCase();
  return /^STF-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(normalized);
}

/**
 * Normalize a license key from user input. Uppercases, trims, and reformats
 * if separators are missing. Returns null if shape is invalid.
 *   "stf a2k7 9pxm t4qh 3rfw" -> "STF-A2K7-9PXM-T4QH-3RFW"
 *   "STFA2K79PXMT4QH3RFW"     -> "STF-A2K7-9PXM-T4QH-3RFW"
 */
export function normalizeLicenseKey(key) {
  if (typeof key !== 'string') return null;
  // Strip everything except alphanumerics, uppercase
  const stripped = key.toUpperCase().replace(/[^0-9A-Z]/g, '');
  // Expect: STF + 16 chars = 19 chars total
  if (!stripped.startsWith('STF') || stripped.length !== 19) return null;
  const body = stripped.slice(3);
  // Validate body characters are in alphabet
  for (const ch of body) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return `STF-${body.slice(0,4)}-${body.slice(4,8)}-${body.slice(8,12)}-${body.slice(12,16)}`;
}
