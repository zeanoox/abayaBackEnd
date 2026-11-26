// End-to-end API tests against a real PostgreSQL database with the mock payment provider.
// Run: TEST_DATABASE_URL=postgresql://.../lorim_test npm test   (the database is wiped!)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/.test(url)) {
  console.error('Set TEST_DATABASE_URL to a database whose name contains "test" (it will be wiped).');
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.PAYMENT_PROVIDER = 'mock';
process.env.NODE_ENV = 'test';
process.env.API_PUBLIC_URL = 'http://localhost:0';

const { pool, query } = await import('../src/lib/db.js');
const { migrate } = await import('../db/migrate.js');
const { seed } = await import('../db/seed.js');
const { createApp } = await import('../src/app.js');
const { payments } = await import('../src/payments/index.js');
const { syncPayment, expireStaleOrders } = await import('../src/services/orders.js');

let server, base;

async function api(method, path, { body, token, form } = {}) {
  const headers = {};
  if (token) headers['X-Cart-Token'] = token;
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form); }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const variantBySku = async (sku) => (await query('SELECT id, stock FROM product_variants WHERE sku = $1', [sku])).rows[0];
const stockOf = async (id) => (await query('SELECT stock FROM product_variants WHERE id = $1', [id])).rows[0].stock;
const orderRow = async (number) => (await query('SELECT * FROM orders WHERE number = $1', [number])).rows[0];

async function newCartWith(sku, quantity = 1) {
  const c = await api('POST', '/api/cart');
  const v = await variantBySku(sku);
  // Make the starting stock predictable (seed stock is pseudo-random).
  if (v.stock < 5) { await query('UPDATE product_variants SET stock = 10 WHERE id = $1', [v.id]); v.stock = 10; }
  const r = await api('POST', '/api/cart/items', { token: c.body.token, body: { variantId: v.id, quantity } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: c.body.token, variant: v, cart: r.body };
}

const customer = {
  locale: 'nl',
  customer: { fullName: 'Test Klant', email: 'Klant@Example.com', phone: '+31 6 12345678' },
  address: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
  shippingMethod: 'nl-standard',
};
const checkout = (token, extra = {}) => api('POST', '/api/checkout', { body: { ...customer, cartToken: token, ...extra } });
const refOf = async (number) => (await query(
  `SELECT provider_ref FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.number = $1 ORDER BY p.created_at DESC LIMIT 1`, [number])).rows[0].provider_ref;

before(async () => {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

describe('catalog', () => {
  test('lists, filters and paginates', async () => {
    const r = await api('GET', '/api/products?category=hijabs&limit=2&page=2&sort=price_asc');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 4);
    assert.equal(r.body.items.length, 2);
    assert.ok(r.body.items[0].price <= r.body.items[1].price || r.body.items[0].salePrice != null);
  });
  test('rejects bad input', async () => {
    assert.equal((await api('GET', '/api/products?minPrice=abc')).status, 400);
    assert.equal((await api('GET', '/api/products/..%2Fetc')).status, 400);
  });
  test('product detail exposes variants without exact stock', async () => {
    const r = await api('GET', '/api/products/noor-embroidered-abaya');
    assert.equal(r.status, 200);
    assert.ok(r.body.variants.every((v) => v.available <= 10 && !('stock' in v)));
  });
});

describe('cart', () => {
  test('refuses more than available stock', async () => {
    const v = (await query(`SELECT id, stock FROM product_variants WHERE stock BETWEEN 1 AND 5 LIMIT 1`)).rows[0];
    const c = await api('POST', '/api/cart');
    const r = await api('POST', '/api/cart/items', { token: c.body.token, body: { variantId: v.id, quantity: v.stock + 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'INSUFFICIENT_STOCK');
    assert.equal(r.body.available, v.stock);
  });
  test('refuses sold-out variants', async () => {
    const v = (await query(`SELECT id FROM product_variants WHERE stock = 0 LIMIT 1`)).rows[0];
    const c = await api('POST', '/api/cart');
    const r = await api('POST', '/api/cart/items', { token: c.body.token, body: { variantId: v.id, quantity: 1 } });
    assert.equal(r.body.error, 'OUT_OF_STOCK');
  });
  test('calculates totals, coupons and free shipping on the server', async () => {
    const v = (await query(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.slug = 'sara-everyday-abaya' AND v.stock >= 2 LIMIT 1`)).rows[0];
    const c = await api('POST', '/api/cart');
    let r = await api('POST', '/api/cart/items', { token: c.body.token, body: { variantId: v.id, quantity: 1 } });
    assert.equal(r.body.subtotal, 5900);
    assert.equal(r.body.shippingCost, 495); // below €75
    r = await api('POST', '/api/cart/coupon', { token: c.body.token, body: { code: 'eid15' } });
    assert.equal(r.body.coupon.valid, false);
    assert.equal(r.body.coupon.error, 'MIN_SUBTOTAL');
    r = await api('POST', '/api/cart/coupon', { token: c.body.token, body: { code: 'WELKOM10' } });
    assert.equal(r.body.discount, 590);
    r = await api('PATCH', `/api/cart/items/${r.body.lines[0].id}`, { token: c.body.token, body: { quantity: 2 } });
    assert.equal(r.body.subtotal, 11800);
    assert.equal(r.body.discount, 1180);
    assert.equal(r.body.shippingCost, 0); // free over €75
    assert.equal(r.body.total, 11800 - 1180);
    r = await api('GET', '/api/cart?country=BE', { token: c.body.token });
    assert.equal(r.body.shipping.code, 'be-standard');
    assert.equal(r.body.shippingCost, 0); // BE is free from €100 after discount; €106.20 qualifies
    await api('PATCH', `/api/cart/items/${r.body.lines[0].id}`, { token: c.body.token, body: { quantity: 1 } });
    r = await api('GET', '/api/cart?country=BE', { token: c.body.token });
    assert.equal(r.body.shippingCost, 795);
    r = await api('GET', '/api/cart?country=US', { token: c.body.token });
    assert.equal(r.body.canCheckout, false); // no shipping method for this country
  });
  test('unknown cart token is a 404', async () => {
    assert.equal((await api('GET', '/api/cart', { token: 'nope-nope-nope' })).status, 404);
  });
});

describe('checkout & payments', () => {
  test('validates customer details', async () => {
    const { token } = await newCartWith('LR-HCHF-OS-BLA');
    const r = await checkout(token, { address: { ...customer.address, postalCode: '12' } });
    assert.equal(r.status, 400);
    assert.ok(r.body.fields.some((f) => f.path === 'address.postalCode'));
  });

  test('successful payment: reserves stock, verifies with provider, clears cart', async () => {
    const { token, variant } = await newCartWith('LR-HCHF-OS-NAV', 2);
    const r = await checkout(token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.checkoutUrl, /\/api\/payments\/mock\//);
    assert.equal(await stockOf(variant.id), variant.stock - 2);

    let o = await orderRow(r.body.orderNumber);
    assert.equal(o.status, 'PENDING_PAYMENT');
    assert.equal(o.email, 'klant@example.com');

    // Visiting the "success" page without paying must NOT mark the order paid.
    let view = await api('GET', `/api/orders/${r.body.orderNumber}?token=${r.body.accessToken}`);
    assert.equal(view.body.status, 'PENDING_PAYMENT');
    assert.ok(view.body.payment.checkoutUrl);

    const ref = await refOf(r.body.orderNumber);
    const pay = await api('POST', `/api/payments/mock/${ref}`, { form: { action: 'paid' } });
    assert.equal(pay.status, 303);

    o = await orderRow(r.body.orderNumber);
    assert.equal(o.status, 'PAID');
    assert.ok(o.paid_at);
    // Webhook delivered twice: no double effects.
    await api('POST', '/api/payments/webhook', { form: { id: ref } });
    await api('POST', '/api/payments/webhook', { form: { id: ref } });
    assert.equal(await stockOf(variant.id), variant.stock - 2);
    assert.equal((await api('GET', '/api/cart', { token })).body.lines.length, 0);

    view = await api('GET', `/api/orders/${r.body.orderNumber}?token=${r.body.accessToken}`);
    assert.equal(view.body.status, 'PAID');
    assert.equal(view.body.items[0].quantity, 2);
    assert.equal(view.body.items[0].sku, 'LR-HCHF-OS-NAV');
  });

  test('failed payment releases stock and keeps the cart', async () => {
    const { token, variant } = await newCartWith('LR-HCHF-OS-BUR');
    const r = await checkout(token);
    assert.equal(await stockOf(variant.id), variant.stock - 1);
    await api('POST', `/api/payments/mock/${await refOf(r.body.orderNumber)}`, { form: { action: 'failed' } });
    assert.equal((await orderRow(r.body.orderNumber)).status, 'CANCELLED');
    assert.equal(await stockOf(variant.id), variant.stock);
    assert.equal((await api('GET', '/api/cart', { token })).body.lines.length, 1);
  });

  test('checking out twice from one cart releases the first order', async () => {
    const { token, variant } = await newCartWith('LR-HCHF-OS-SAG');
    const a = await checkout(token);
    const b = await checkout(token);
    assert.equal(b.status, 201);
    assert.equal((await orderRow(a.body.orderNumber)).status, 'CANCELLED');
    assert.equal((await orderRow(b.body.orderNumber)).status, 'PENDING_PAYMENT');
    assert.equal(await stockOf(variant.id), variant.stock - 1);
  });

  test('never oversells the last item under concurrent checkouts', async () => {
    const carts = [];
    for (let i = 0; i < 5; i++) carts.push(await newCartWith('LR-HCHF-OS-BEI'));
    // Five customers have it in their cart; only one unit is left.
    const v = await variantBySku('LR-HCHF-OS-BEI');
    await query('UPDATE product_variants SET stock = 1 WHERE id = $1', [v.id]);
    const results = await Promise.all(carts.map((c) => checkout(c.token)));
    const ok = results.filter((r) => r.status === 201);
    assert.equal(ok.length, 1, results.map((r) => r.status).join(','));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(await stockOf(v.id), 0);
  });

  test('coupon usage limit is enforced at checkout', async () => {
    await query(`INSERT INTO coupons (code, type, value, usage_limit) VALUES ('ONCE', 'PERCENT', 10, 1)`);
    const a = await newCartWith('LR-HJRS-OS-BLA');
    const b = await newCartWith('LR-HJRS-OS-BLA');
    await api('POST', '/api/cart/coupon', { token: a.token, body: { code: 'ONCE' } });
    await api('POST', '/api/cart/coupon', { token: b.token, body: { code: 'ONCE' } });
    assert.equal((await checkout(a.token)).status, 201);
    const second = await checkout(b.token);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'COUPON_INVALID');
  });

  test('order access needs the token or matching e-mail', async () => {
    const { token } = await newCartWith('LR-HJRS-OS-BEI');
    const r = await checkout(token);
    assert.equal((await api('GET', `/api/orders/${r.body.orderNumber}?token=wrong-token-123`)).status, 404);
    const look = await api('POST', '/api/orders/lookup', { body: { number: r.body.orderNumber, email: 'KLANT@example.com' } });
    assert.equal(look.status, 200);
    assert.equal(look.body.shippingAddress, undefined);
    assert.equal((await api('POST', '/api/orders/lookup', { body: { number: r.body.orderNumber, email: 'x@y.nl' } })).status, 404);
  });

  test('webhook ignores junk and unknown ids', async () => {
    assert.equal((await api('POST', '/api/payments/webhook', { form: { id: "tr_1' OR 1=1" } })).status, 400);
    assert.equal((await api('POST', '/api/payments/webhook', { form: { id: 'tr_unknown123' } })).status, 200);
  });

  test('abandoned orders expire and release stock; a late payment re-reserves it', async () => {
    const { token, variant } = await newCartWith('LR-HJRS-OS-MOC');
    const r = await checkout(token);
    await query(`UPDATE orders SET created_at = now() - interval '2 hours' WHERE number = $1`, [r.body.orderNumber]);
    await expireStaleOrders();
    assert.equal((await orderRow(r.body.orderNumber)).status, 'CANCELLED');
    assert.equal(await stockOf(variant.id), variant.stock);

    const ref = await refOf(r.body.orderNumber);
    payments()._set(ref, 'paid');
    await syncPayment(ref);
    const o = await orderRow(r.body.orderNumber);
    assert.equal(o.status, 'PAID');
    assert.equal(o.stock_reserved, true);
    assert.equal(await stockOf(variant.id), variant.stock - 1);
  });

  test('prices are always taken from the database', async () => {
    const { token } = await newCartWith('LR-HMDL-OS-SAN');
    const r = await checkout(token, { expectedTotal: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'PRICE_CHANGED');
  });
});
