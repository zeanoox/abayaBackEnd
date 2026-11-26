import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../lib/errors.js';
import { addItem, createCart, findCart, MAX_LINE_QTY, removeItem, setCoupon, setItemQty } from '../services/cart.js';
import { priceCart, publicCart } from '../services/pricing.js';

const r = Router();
const uuid = z.string().uuid();
const opts = z.object({
  country: z.string().length(2).toUpperCase().default('NL'),
  shipping: z.string().max(40).optional(),
});

// The cart token travels in a header, so it never ends up in URLs or server logs.
const token = (req) => req.get('X-Cart-Token');

async function respond(req, res, cart) {
  const o = opts.parse(req.query);
  res.set('Cache-Control', 'no-store');
  res.json(publicCart(cart.token, await priceCart(cart, o)));
}

r.post('/cart', ah(async (req, res) => {
  const cart = await createCart();
  res.status(201);
  await respond(req, res, { ...cart, coupon_code: null });
}));

r.get('/cart', ah(async (req, res) => respond(req, res, await findCart(token(req)))));

r.post('/cart/items', ah(async (req, res) => {
  const body = z.object({ variantId: uuid, quantity: z.number().int().min(1).max(MAX_LINE_QTY).default(1) }).parse(req.body);
  const cart = await findCart(token(req));
  await addItem(cart, body.variantId, body.quantity);
  await respond(req, res, cart);
}));

r.patch('/cart/items/:id', ah(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { quantity } = z.object({ quantity: z.number().int().min(0).max(MAX_LINE_QTY) }).parse(req.body);
  const cart = await findCart(token(req));
  await setItemQty(cart, id, quantity);
  await respond(req, res, cart);
}));

r.delete('/cart/items/:id', ah(async (req, res) => {
  const cart = await findCart(token(req));
  await removeItem(cart, uuid.parse(req.params.id));
  await respond(req, res, cart);
}));

r.post('/cart/coupon', ah(async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/) }).parse(req.body);
  const cart = await findCart(token(req));
  await setCoupon(cart, code);
  await respond(req, res, { ...cart, coupon_code: code.toUpperCase() });
}));

r.delete('/cart/coupon', ah(async (req, res) => {
  const cart = await findCart(token(req));
  await setCoupon(cart, null);
  await respond(req, res, { ...cart, coupon_code: null });
}));

export default r;
