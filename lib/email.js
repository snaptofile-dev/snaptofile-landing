// lib/email.js
// Thin wrapper around the Resend SDK. Centralizes the From/Reply-To addresses
// so we don't leak them across modules.
//
// Required env vars:
//   RESEND_API_KEY  — re_... (sending-scoped key, restricted to the verified domain)
//
// From/Reply-To convention (locked 2026-04-27):
//   From:     SnapToFile <hello@send.snaptofile.com>   (Resend-verified subdomain)
//   Reply-To: hello@snaptofile.com                      (Porkbun-forwarded → personal inbox)

import { Resend } from 'resend';

const FROM_ADDRESS     = 'SnapToFile <hello@send.snaptofile.com>';
const REPLY_TO_ADDRESS = 'hello@snaptofile.com';

let resendInstance = null;

function getResend() {
  if (!resendInstance) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY env var is missing');
    }
    resendInstance = new Resend(process.env.RESEND_API_KEY);
  }
  return resendInstance;
}

/**
 * Send an email via Resend. Throws on failure.
 *
 * @param {object} args
 * @param {string} args.to       — recipient address
 * @param {string} args.subject
 * @param {string} args.html     — HTML body
 * @param {string} args.text     — plain-text body
 * @returns {Promise<{ id: string }>}
 */
export async function sendEmail({ to, subject, html, text }) {
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from:    FROM_ADDRESS,
    to:      [to],
    replyTo: REPLY_TO_ADDRESS,
    subject,
    html,
    text,
  });
  if (error) {
    // Resend's SDK returns errors as data instead of throwing — surface them.
    throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
  }
  return data;
}
