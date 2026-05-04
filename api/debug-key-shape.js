// api/debug-key-shape.js
// TEMPORARY diagnostic endpoint. Reports the SHAPE of LICENSE_PRIVATE_KEY
// without leaking its contents. Used to diagnose Vercel env var paste issues.
//
// THIS FILE WILL BE DELETED AFTER CHUNK 5 DIAGNOSIS IS COMPLETE.
//
// Returns:
//   {
//     present: bool,                 // env var exists at all
//     length: number,                // total character count
//     starts_with: string,           // first 30 chars (BEGIN marker is not secret)
//     ends_with: string,             // last 30 chars (END marker is not secret)
//     contains_newline_lf: bool,     // has \n
//     contains_newline_crlf: bool,   // has \r\n (Windows-style)
//     contains_literal_backslash_n: bool, // has the two-char sequence \n
//     contains_dash_dash: bool,      // has the BEGIN/END dashes at all
//     line_count: number,            // how many lines split by \n
//     line_lengths: number[],        // length of each line (helps spot wrapping)
//     normalized_starts_with: string,// after normalizePemString runs
//     normalized_line_count: number, // after normalizePemString runs
//   }

export default async function handler(req, res) {
  const raw = process.env.LICENSE_PRIVATE_KEY;

  if (!raw) {
    return res.status(200).json({
      present: false,
      message: 'LICENSE_PRIVATE_KEY is not set in this environment',
    });
  }

  // Run the same normalizer that lib/jwt.js uses
  const normalized = normalizePemString(raw);
  const normalizedLines = normalized.split('\n');

  const lines = raw.split('\n');
  const result = {
    present: true,
    length: raw.length,
    starts_with: raw.slice(0, 30),
    ends_with: raw.slice(-30),
    contains_newline_lf:          raw.includes('\n'),
    contains_newline_crlf:        raw.includes('\r\n'),
    contains_literal_backslash_n: raw.includes('\\n'),
    contains_dash_dash:           raw.includes('--'),
    line_count:                   lines.length,
    line_lengths:                 lines.map(l => l.length),
    normalized_starts_with:       normalized.slice(0, 60),
    normalized_line_count:        normalizedLines.length,
    normalized_first_3_lines:     normalizedLines.slice(0, 3).map(l => `[${l.length}] ${l.slice(0, 30)}`),
    normalized_last_3_lines:      normalizedLines.slice(-3).map(l => `[${l.length}] ${l.slice(0, 30)}`),
  };

  return res.status(200).json(result);
}

// Inlined copy of normalizePemString from lib/jwt.js — kept inline so this
// file is self-contained and easy to delete after diagnosis.
function normalizePemString(pem) {
  if (typeof pem !== 'string' || pem.length === 0) return pem;
  const re = /-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/;
  const match = pem.match(re);
  if (!match) return pem;
  const label = match[1];
  const body  = match[2].replace(/\s+/g, '');
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}
