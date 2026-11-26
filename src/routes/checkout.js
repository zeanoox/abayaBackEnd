import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../lib/errors.js';
import { config } from '../lib/config.js';
import { query } from '../lib/db.js';
import { createOrder, getOrderForCustomer, syncPayment } from '../services/orders.js';
import { payments } from '../payments/index.js';

const r = Router();

// Postal code formats for the countries we ship to most; others get a generic check.
const POSTAL = {
  NL: /^[1-9][0-9]{3}\s?[A-Za-z]{2}$/,
  BE: /^[1-9][0-9]{3}$/,
  DE: /^[0-9]{5}$/,
  FR: /^[0-9]{5}$/,
  LU: /^[0-9]{4}$/,
};

const text = (max) => z.string().trim().min(1).max(max);

const checkoutSchema = z.object({
  cartToken: z.string().min(10).max(64),
  locale: z.enum(['nl', 'en', 'ar']).default('nl'),
  customer: z.object({
    fullName: text(120),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/, 'Invalid phone number'),
  }),
  address: z.object({
    line1: text(160),
    line2: z.string().trim().max(160).optional(),
    city: text(80),
    postalCode: text(12),
    country: z.string().length(2).toUpperCase(),
  }),
  shippingMethod: z.string().max(40),
  expectedTotal: z.number().int().nonnegative().optional(),
}).superRefine((v, ctx) => {
  const re = POSTAL[v.address.country] || /^[A-Za-z0-9 -]{3,10}$/;
  if (!re.test(v.address.postalCode)) {
    ctx.addIssue({ code: 'custom', path: ['address', 'postalCode'], message: 'Invalid postal code' });
  }
});

r.post('/checkout', ah(async (req, res) => {
  const input = checkoutSchema.parse(req.body);
  res.status(201).json(await createOrder(input));
}));

// Order status for the customer. Guests use the secret token from their confirmation link.
r.get('/orders/:number', ah(async (req, res) => {
  const number = z.string().regex(/^LR-\d{5,9}$/).parse(req.params.number);
  const token = z.string().min(10).max(64).parse(req.query.token);
  res.set('Cache-Control', 'no-store');
  res.json(await getOrderForCustomer({ number, token }));
}));

// Guest lookup by order number + e-mail address.
r.post('/orders/lookup', ah(async (req, res) => {
  const { number, email } = z.object({
    number: z.string().trim().toUpperCase().regex(/^LR-\d{5,9}$/),
    email: z.string().trim().email(),
  }).parse(req.body);
  res.set('Cache-Control', 'no-store');
  res.json(await getOrderForCustomer({ number, email }));
}));

// ---------- Payment webhook ----------
// Mollie only sends the payment id. We never trust the request body for the status:
// syncPayment() fetches the payment from Mollie's API and acts on that.
r.post('/payments/webhook', express.urlencoded({ extended: false, limit: '2kb' }), ah(async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!/^(tr_|mock_)[A-Za-z0-9]+$/.test(id)) throw new HttpError(400, 'BAD_ID', 'Invalid payment id');
  await syncPayment(id); // unknown ids are ignored
  res.sendStatus(200);
}));

// ---------- Local mock payment page (development only) ----------
if (!config.isProd) {
  r.get('/payments/mock/:ref', ah(async (req, res) => {
    if (payments().name !== 'mock') throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const p = payments()._get(req.params.ref);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Unknown payment');
    const { rows } = await query('SELECT number FROM orders WHERE id = $1', [p.orderId]);
    const euro = (p.amount / 100).toFixed(2).replace('.', ',');
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width">
<title>Test payment</title>
<body style="font-family:system-ui;background:#f5f1ea;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" style="background:#fff;padding:2rem;max-width:360px;text-align:center;border:1px solid #ddd">
<p style="color:#a33;font-weight:600">TEST MODE – no real money</p>
<h2>Order ${rows[0]?.number ?? ''}</h2><p>Amount: €${euro}</p><p>Status: ${p.status}</p>
<button name="action" value="paid" style="display:block;width:100%;padding:.8rem;margin:.4rem 0;background:#5f6146;color:#fff;border:0">Pay (success)</button>
<button name="action" value="failed" style="display:block;width:100%;padding:.8rem;margin:.4rem 0">Fail payment</button>
<button name="action" value="canceled" style="display:block;width:100%;padding:.8rem;margin:.4rem 0">Cancel</button>
<button name="action" value="return" style="display:block;width:100%;padding:.8rem;margin:.4rem 0">Return without paying</button>
</form></body>`);
  }));

  r.post('/payments/mock/:ref', express.urlencoded({ extended: false }), ah(async (req, res) => {
    if (payments().name !== 'mock') throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const p = payments()._get(req.params.ref);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Unknown payment');
    if (['paid', 'failed', 'canceled'].includes(req.body.action)) {
      payments()._set(req.params.ref, req.body.action);
      await syncPayment(req.params.ref); // what a Mollie webhook would trigger
    }
    res.redirect(303, p.redirectUrl);
  }));
}

export default r;
