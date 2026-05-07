// api/checkout.js
// Vercel serverless function — creates a Stripe Checkout Session for the SnapToFile Pro subscription.
// Called from the landing page's "Skip the trial — subscribe to Pro" link.
//
// Environment variables required:
//   STRIPE_SECRET_KEY  — sk_test_... (or sk_live_... in production)
//   STRIPE_PRICE_ID    — price_... for the $15/mo SnapToFile Pro recurring price
//   APP_URL            — https://snaptofile.com (or https://<preview>.vercel.app for preview deploys)

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Sanity-check env vars at runtime so misconfiguration produces a useful 500
  // instead of a confusing Stripe API error.
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID || !process.env.APP_URL) {
    console.error('[checkout] missing required env var', {
      hasSecret: !!process.env.STRIPE_SECRET_KEY,
      hasPrice:  !!process.env.STRIPE_PRICE_ID,
      hasAppUrl: !!process.env.APP_URL,
    });
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Optional coupon passed from landing page pop-up offer (e.g. FIRST50).
  // Stripe disallows allow_promotion_codes + discounts in the same session,
  // so we swap them: coupon present → auto-apply it; absent → let user enter one.
  const coupon = typeof req.body?.coupon === 'string' ? req.body.coupon.trim() : null;

  try {
    const sessionConfig = {
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      // Stripe collects email automatically in Checkout. We capture it again from
      // the session in the webhook (Chunk 4) for license generation.
      billing_address_collection: 'auto',
      success_url: `${process.env.APP_URL}/app/pro?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/app/pro?checkout=canceled`,
    };

    if (coupon) {
      // Auto-apply the coupon — user sees the discount applied before paying.
      sessionConfig.discounts = [{ coupon }];
    } else {
      // No coupon — let users enter promo codes themselves at checkout.
      sessionConfig.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    // 303 redirect so a plain HTML form-POST from /app/pro flows cleanly to
    // Stripe's hosted Checkout page. (200 + JSON would render as a blank page
    // showing the response body — see Chunk 8 cutover bug, 2026-05-05.)
    res.setHeader('Location', session.url);
    return res.status(303).end();
  } catch (err) {
    console.error('[checkout] Stripe error:', err);
    return res.status(500).json({
      error: 'Failed to create checkout session',
      // Surface Stripe's message in test mode for easier debugging; safe to keep
      // since checkout-session creation never returns sensitive data.
      message: err.message,
    });
  }
}
