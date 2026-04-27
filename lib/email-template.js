// lib/email-template.js
// HTML + plain-text email content for SnapToFile Pro license delivery.
//
// Design constraints for HTML email:
//   - Inline styles only (Gmail strips <style> blocks in many cases)
//   - Web-safe font fallbacks (custom fonts won't load in most clients)
//   - Single-column layout, max width 560px (renders well on mobile)
//   - No background-image (Outlook ignores them)
//   - Buttons are styled <a> tags (VML for Outlook would be nicer but
//     this gracefully degrades)
//
// Brand colors hard-coded to match snaptofile.com:
//   cream    #f5efe6  (page bg)
//   paper    #fbf7ef  (card bg, license-box bg)
//   ink      #1a1a1a  (primary text)
//   muted    #6b6b6b  (secondary text)
//   sage     #4a5c3f  (CTA)
//   sage-deep #33432b (CTA hover — emails ignore this but kept for parity)
//   rule     #d9cfb9  (dividers)

/**
 * Build the full email envelope for the welcome+license email.
 * Returns { subject, html, text }.
 */
export function buildWelcomeEmail({ licenseKey, downloadUrl, customerEmail }) {
  const subject = 'Welcome to SnapToFile Pro — your license key';
  return {
    subject,
    html: htmlBody({ licenseKey, downloadUrl, customerEmail }),
    text: textBody({ licenseKey, downloadUrl, customerEmail }),
  };
}

function htmlBody({ licenseKey, downloadUrl, customerEmail }) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to SnapToFile Pro</title>
</head>
<body style="margin:0;padding:0;background-color:#f5efe6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5efe6;">
  <tr>
    <td align="center" style="padding:40px 16px;">

      <!-- Wrapper card -->
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#fbf7ef;border:1px solid #d9cfb9;border-radius:8px;">

        <!-- Brand header -->
        <tr>
          <td style="padding:32px 36px 8px 36px;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#4a5c3f;">
              SnapToFile
            </div>
          </td>
        </tr>

        <!-- Headline -->
        <tr>
          <td style="padding:8px 36px 16px 36px;">
            <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:28px;line-height:1.2;letter-spacing:-0.01em;color:#1a1a1a;">
              Welcome to SnapToFile Pro.
            </h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:0 36px 24px 36px;font-size:16px;line-height:1.6;color:#2d2d2d;">
            <p style="margin:0 0 16px 0;">
              Thanks for subscribing. Your license is below — you'll need it to activate the Pro build the first time you open it. Save this email; you can re-activate on a new device any time.
            </p>
          </td>
        </tr>

        <!-- License key box -->
        <tr>
          <td style="padding:0 36px 28px 36px;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#6b6b6b;margin-bottom:8px;">
              Your license key
            </div>
            <div style="background-color:#f5efe6;border:1px solid #d9cfb9;border-radius:6px;padding:18px 20px;font-family:'SF Mono',Menlo,Monaco,Consolas,'Courier New',monospace;font-size:18px;font-weight:600;letter-spacing:0.04em;color:#1a1a1a;text-align:center;word-break:break-all;">
              ${escapeHtml(licenseKey)}
            </div>
          </td>
        </tr>

        <!-- Download CTA -->
        <tr>
          <td style="padding:0 36px 32px 36px;" align="center">
            <a href="${escapeAttr(downloadUrl)}" style="display:inline-block;background-color:#4a5c3f;color:#ffffff;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px;text-decoration:none;letter-spacing:0.01em;">
              Download SnapToFile Pro &rarr;
            </a>
          </td>
        </tr>

        <!-- Activation steps -->
        <tr>
          <td style="padding:0 36px 8px 36px;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#4a5c3f;margin-bottom:10px;">
              How to activate
            </div>
            <ol style="margin:0 0 24px 0;padding-left:20px;font-size:15px;line-height:1.7;color:#2d2d2d;">
              <li>Click the download button above to save the Pro file.</li>
              <li>Open it in your browser (Chrome, Edge, or Safari).</li>
              <li>Paste the license key when prompted, then click <strong>Activate</strong>.</li>
              <li>You're set. The activation is bound to your device — you can move the file freely.</li>
            </ol>
          </td>
        </tr>

        <!-- Divider -->
        <tr>
          <td style="padding:0 36px;">
            <div style="border-top:1px solid #d9cfb9;height:1px;line-height:1px;font-size:1px;">&nbsp;</div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 36px 32px 36px;font-size:13px;line-height:1.6;color:#6b6b6b;">
            <p style="margin:0 0 12px 0;">
              Need help, lost your key, or want a refund? Just reply to this email — replies go straight to me.
            </p>
            <p style="margin:0;font-size:12px;color:#8b8b8b;">
              You're receiving this because you subscribed at <a href="https://snaptofile.com" style="color:#4a5c3f;text-decoration:underline;">snaptofile.com</a>${customerEmail ? ` with ${escapeHtml(customerEmail)}` : ''}.
            </p>
          </td>
        </tr>

      </table>

      <!-- Outer footer -->
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;margin-top:20px;">
        <tr>
          <td align="center" style="padding:0 16px;font-size:11px;line-height:1.5;color:#8b8b8b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
            SnapToFile · Documentation, done properly.
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
</body>
</html>`;
}

function textBody({ licenseKey, downloadUrl, customerEmail }) {
  return [
    'Welcome to SnapToFile Pro.',
    '',
    "Thanks for subscribing. Your license is below — you'll need it to",
    "activate the Pro build the first time you open it. Save this email;",
    "you can re-activate on a new device any time.",
    '',
    'YOUR LICENSE KEY',
    licenseKey,
    '',
    'DOWNLOAD',
    downloadUrl,
    '',
    'HOW TO ACTIVATE',
    '  1. Click the download link above to save the Pro file.',
    '  2. Open it in your browser (Chrome, Edge, or Safari).',
    '  3. Paste the license key when prompted, then click Activate.',
    '  4. The activation is bound to your device — you can move the file freely.',
    '',
    '——',
    '',
    'Need help, lost your key, or want a refund? Just reply to this',
    'email — replies go straight to me.',
    '',
    customerEmail
      ? `You're receiving this because you subscribed at snaptofile.com with ${customerEmail}.`
      : `You're receiving this because you subscribed at snaptofile.com.`,
    '',
    'SnapToFile · Documentation, done properly.',
  ].join('\n');
}

// --- escapers --------------------------------------------------------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Stricter — for use inside HTML attributes (href, etc).
function escapeAttr(s) {
  return escapeHtml(s);
}
