import crypto from 'node:crypto';
import { query, tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import { HttpError, notFound } from '../lib/errors.js';
import { findCart, variantLabel } from './cart.js';
import { priceCart } from './pricing.js';
import { payments, PAYMENT_STATUS } from '../payments/index.js';

const event = (db, orderId, type, message) =>
  db.query('INSERT INTO order_events (order_id, type, message) VALUES ($1,$2,$3)', [orderId, type, message]);

/**
 * Turns a cart into an order and reserves the stock, all in one transaction.
 * Stock is decremented with a guarded UPDATE, so two customers can never buy the same last item.
 */
export async function createOrder(input) {
  const order = await tx(async (db) => {
    const cart = await findCart(input.cartToken, db);
    // Lock the cart row: double-clicking "Pay" cannot create two orders.
    await db.query('SELECT 1 FROM carts WHERE id = $1 FOR UPDATE', [cart.id]);

    // A previous unpaid order from this cart is cancelled first, releasing its stock.
    if (cart.pending_order_id) await releaseOrder(cart.pending_order_id, 'Superseded by a new checkout', db);

    const priced = await priceCart(cart, { country: input.address.country, shipping: input.shippingMethod }, db, { lock: true });
    if (!priced.lines.length) throw new HttpError(400, 'CART_EMPTY', 'Your cart is empty');
    if (priced.lines.some((l) => l.issue)) {
      throw new HttpError(409, 'CART_CHANGED', 'Some items are no longer available in the chosen quantity',
        { lines: priced.lines.filter((l) => l.issue).map((l) => ({ id: l.id, issue: l.issue, available: l.available })) });
    }
    if (!priced.shipping || priced.shipping.code !== input.shippingMethod) {
      throw new HttpError(400, 'SHIPPING_UNAVAILABLE', 'This shipping method is not available for your country');
    }
    if (cart.coupon_code && !priced.couponRaw?.valid) {
      throw new HttpError(409, 'COUPON_INVALID', 'The discount code can no longer be used', { coupon: priced.coupon });
    }
    if (input.expectedTotal != null && input.expectedTotal !== priced.total) {
      throw new HttpError(409, 'PRICE_CHANGED', 'Prices changed since you opened checkout', { total: priced.total });
    }

    const { rows } = await db.query(
      `INSERT INTO orders (access_token, locale, email, full_name, phone, ship_line1, ship_line2, ship_city,
         ship_postal_code, ship_country, shipping_method_id, shipping_name, subtotal, discount, shipping_cost, total, coupon_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, number, access_token, total, currency, locale`,
      [crypto.randomBytes(24).toString('base64url'), input.locale, input.customer.email.toLowerCase(),
        input.customer.fullName, input.customer.phone, input.address.line1, input.address.line2 || null,
        input.address.city, input.address.postalCode.toUpperCase(), input.address.country, priced.shipping.id,
        priced.shipping.name[input.locale] || priced.shipping.name.en, priced.subtotal, priced.discount,
        priced.shippingCost, priced.total, priced.couponRaw?.valid ? priced.couponRaw.code : null]);
    const o = rows[0];

    for (const l of priced.lines) {
      const upd = await db.query(
        'UPDATE product_variants SET stock = stock - $1, updated_at = now() WHERE id = $2 AND stock >= $1',
        [l.quantity, l.variantId]);
      if (upd.rowCount !== 1) throw new HttpError(409, 'OUT_OF_STOCK', 'An item just sold out', { variantId: l.variantId });
      await db.query(
        `INSERT INTO stock_adjustments (variant_id, delta, reason, order_id) VALUES ($1,$2,'RESERVE_ORDER',$3)`,
        [l.variantId, -l.quantity, o.id]);
      await db.query(
        `INSERT INTO order_items (order_id, variant_id, product_name, sku, variant_label, image_url, unit_price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [o.id, l.variantId, l.product.name, l.variant.sku, variantLabel(l, input.locale), l.image, l.unitPrice, l.quantity, l.lineTotal]);
    }

    if (priced.couponRaw?.valid) {
      const used = await db.query(
        `UPDATE coupons SET used_count = used_count + 1 WHERE id = $1 AND (usage_limit IS NULL OR used_count < usage_limit)`,
        [priced.couponRaw.id]);
      if (used.rowCount !== 1) throw new HttpError(409, 'COUPON_INVALID', 'The discount code has reached its limit');
    }

    await db.query('UPDATE carts SET pending_order_id = $1 WHERE id = $2', [o.id, cart.id]);
    await event(db, o.id, 'STATUS', 'Order created, stock reserved, awaiting payment');
    return o;
  });

  // Payment is created after the transaction, so a slow provider never holds database locks.
  try {
    const checkoutUrl = await startPayment(order);
    return { orderNumber: order.number, accessToken: order.access_token, checkoutUrl };
  } catch (err) {
    console.error('[payments] create failed', err.message);
    await tx((db) => releaseOrder(order.id, 'Payment could not be started', db));
    throw new HttpError(502, 'PAYMENT_UNAVAILABLE', 'The payment provider is unavailable, please try again');
  }
}

async function startPayment(order) {
  const redirectUrl = `${config.frontendUrl}/order/${order.number}?token=${encodeURIComponent(order.access_token)}`;
  const p = await payments().createPayment({ order, redirectUrl });
  await query(
    `INSERT INTO payments (order_id, provider, provider_ref, status, amount, currency, checkout_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [order.id, payments().name, p.ref, PAYMENT_STATUS[p.status] || 'OPEN', order.total, order.currency, p.checkoutUrl]);
  await event({ query }, order.id, 'PAYMENT', `Payment ${p.ref} created`);
  return p.checkoutUrl;
}

/** Cancels an unpaid order and gives its reserved stock back. Idempotent. */
export async function releaseOrder(orderId, reason, db) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), stock_reserved = false, updated_at = now()
     WHERE id = $1 AND status = 'PENDING_PAYMENT' RETURNING id, coupon_code, stock_reserved`, [orderId]);
  if (!rows[0]) return false;
  const items = await db.query('SELECT variant_id, quantity FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL', [orderId]);
  for (const it of items.rows) {
    await db.query('UPDATE product_variants SET stock = stock + $1, updated_at = now() WHERE id = $2', [it.quantity, it.variant_id]);
    await db.query(`INSERT INTO stock_adjustments (variant_id, delta, reason, order_id) VALUES ($1,$2,'RELEASE_ORDER',$3)`,
      [it.variant_id, it.quantity, orderId]);
  }
  if (rows[0].coupon_code) {
    await db.query('UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE code = $1', [rows[0].coupon_code]);
  }
  await db.query('UPDATE carts SET pending_order_id = NULL WHERE pending_order_id = $1', [orderId]);
  await event(db, orderId, 'STATUS', `Cancelled: ${reason}. Stock released.`);
  return true;
}

/**
 * Re-reads a payment from the provider and applies the result. Called by the webhook,
 * the order status page and the expiry job — never trusts anything the browser says.
 */
export async function syncPayment(ref) {
  const { rows } = await query('SELECT id, order_id, status, amount FROM payments WHERE provider_ref = $1', [ref]);
  const local = rows[0];
  if (!local) return null; // unknown id: ignore (could be a probe)

  const remote = await payments().getPayment(ref);
  const status = PAYMENT_STATUS[remote.status] || 'OPEN';

  return tx(async (db) => {
    await db.query(
      `UPDATE payments SET status = $1, method = COALESCE($2, method), refunded = $3, updated_at = now() WHERE id = $4`,
      [status, remote.method, remote.refunded || 0, local.id]);
    const { rows: [order] } = await db.query('SELECT id, status, total, stock_reserved FROM orders WHERE id = $1 FOR UPDATE', [local.order_id]);

    if (status === 'PAID') {
      if (remote.amount !== order.total) {
        await event(db, order.id, 'PAYMENT', `Paid amount ${remote.amount} does not match order total ${order.total} — check manually`);
      }
      if (order.status === 'PENDING_PAYMENT') {
        await markPaid(db, order.id, ref);
      } else if (order.status === 'CANCELLED') {
        // Paid after the reservation expired: try to take the stock again, otherwise flag for a refund.
        const ok = await rereserve(db, order.id);
        await db.query(`UPDATE orders SET status = 'PAID', paid_at = now(), stock_reserved = $2, cancelled_at = NULL,
          internal_notes = concat_ws(E'\n', internal_notes, $3::text) WHERE id = $1`,
          [order.id, ok, ok ? null : 'Paid after reservation expired and stock is no longer available — refund or restock.']);
        await event(db, order.id, 'PAYMENT', ok ? 'Late payment received; stock re-reserved' : 'Late payment received; STOCK UNAVAILABLE — action needed');
      }
    } else if (['FAILED', 'CANCELED', 'EXPIRED'].includes(status) && order.status === 'PENDING_PAYMENT') {
      // Only release if no other payment for this order is still alive.
      const alive = await db.query(
        `SELECT 1 FROM payments WHERE order_id = $1 AND id <> $2 AND status IN ('OPEN','PENDING','AUTHORIZED','PAID')`,
        [order.id, local.id]);
      if (!alive.rowCount) await releaseOrder(order.id, `payment ${status.toLowerCase()}`, db);
    }
    return status;
  });
}

async function markPaid(db, orderId, ref) {
  await db.query(`UPDATE orders SET status = 'PAID', paid_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
  await db.query(
    `UPDATE products p SET sales_count = sales_count + x.qty FROM (
       SELECT v.product_id, sum(oi.quantity) AS qty FROM order_items oi JOIN product_variants v ON v.id = oi.variant_id
       WHERE oi.order_id = $1 GROUP BY v.product_id) x WHERE p.id = x.product_id`, [orderId]);
  // The customer's cart has done its job.
  await db.query(
    `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE pending_order_id = $1)`, [orderId]);
  await db.query(`UPDATE carts SET pending_order_id = NULL, coupon_code = NULL WHERE pending_order_id = $1`, [orderId]);
  await event(db, orderId, 'PAYMENT', `Payment ${ref} verified with provider: paid`);
}

/** Takes the stock again for an order that was paid late. All-or-nothing via a savepoint. */
async function rereserve(db, orderId) {
  await db.query('SAVEPOINT rereserve');
  const items = await db.query('SELECT variant_id, quantity FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL', [orderId]);
  for (const it of items.rows) {
    const u = await db.query('UPDATE product_variants SET stock = stock - $1 WHERE id = $2 AND stock >= $1', [it.quantity, it.variant_id]);
    if (u.rowCount !== 1) {
      await db.query('ROLLBACK TO SAVEPOINT rereserve');
      return false;
    }
    await db.query(`INSERT INTO stock_adjustments (variant_id, delta, reason, order_id) VALUES ($1,$2,'RESERVE_ORDER',$3)`,
      [it.variant_id, -it.quantity, orderId]);
  }
  await db.query('RELEASE SAVEPOINT rereserve');
  return true;
}

/** Order view for the customer (guest via access token or order number + email). */
export async function getOrderForCustomer({ number, token, email }) {
  const { rows } = await query(
    `SELECT id, number, status, email, full_name, phone, ship_line1, ship_line2, ship_city, ship_postal_code, ship_country,
       shipping_name, subtotal, discount, shipping_cost, total, currency, coupon_code, created_at, paid_at, access_token
     FROM orders WHERE number = $1`, [number]);
  const o = rows[0];
  const tokenOk = o && token && safeEqual(o.access_token, token);
  const emailOk = o && email && o.email === email.trim().toLowerCase();
  if (!tokenOk && !emailOk) throw notFound('Order');

  // While waiting for payment, ask the provider directly (covers missed or slow webhooks).
  if (o.status === 'PENDING_PAYMENT') {
    const p = await query(`SELECT provider_ref FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id]);
    if (p.rows[0]) {
      try {
        await syncPayment(p.rows[0].provider_ref);
        const fresh = await query('SELECT status, paid_at FROM orders WHERE id = $1', [o.id]);
        Object.assign(o, fresh.rows[0]);
      } catch (err) {
        console.warn('[payments] status refresh failed', err.message);
      }
    }
  }

  const [items, pay, ship] = await Promise.all([
    query(`SELECT product_name, sku, variant_label, image_url, unit_price, quantity, line_total FROM order_items WHERE order_id = $1`, [o.id]),
    query(`SELECT status, method, checkout_url FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id]),
    query(`SELECT carrier, tracking_number, tracking_url, shipped_at, delivered_at FROM shipments WHERE order_id = $1 ORDER BY created_at DESC`, [o.id]),
  ]);
  const payment = pay.rows[0];
  return {
    number: o.number,
    status: o.status,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    email: o.email,
    fullName: o.full_name,
    shippingAddress: tokenOk ? {
      line1: o.ship_line1, line2: o.ship_line2, city: o.ship_city, postalCode: o.ship_postal_code, country: o.ship_country,
    } : undefined, // order-number + email lookups don't reveal the address
    shippingName: o.shipping_name,
    items: items.rows.map((i) => ({
      name: i.product_name, sku: i.sku, variant: i.variant_label, image: i.image_url,
      unitPrice: i.unit_price, quantity: i.quantity, lineTotal: i.line_total,
    })),
    subtotal: o.subtotal,
    discount: o.discount,
    couponCode: o.coupon_code,
    shippingCost: o.shipping_cost,
    total: o.total,
    currency: o.currency,
    payment: payment ? {
      status: payment.status,
      method: payment.method,
      // Only offer the provider link while that payment can still be completed.
      checkoutUrl: o.status === 'PENDING_PAYMENT' && payment.status === 'OPEN' ? payment.checkout_url : null,
    } : null,
    shipments: ship.rows,
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Releases stock held by orders that were never paid. Runs on a timer. */
export async function expireStaleOrders() {
  const { rows } = await query(
    `SELECT o.id, (SELECT provider_ref FROM payments p WHERE p.order_id = o.id ORDER BY created_at DESC LIMIT 1) AS ref
     FROM orders o WHERE o.status = 'PENDING_PAYMENT' AND o.created_at < now() - make_interval(mins => $1)
     LIMIT 50`, [config.reservationMinutes]);
  for (const r of rows) {
    try {
      const status = r.ref ? await syncPayment(r.ref) : null;
      // Still open (customer abandoned the payment page): release. "pending" (e.g. bank processing) is kept.
      if (!status || status === 'OPEN') await tx((db) => releaseOrder(r.id, 'reservation expired', db));
    } catch (err) {
      console.warn(`[orders] expiry check failed for ${r.id}:`, err.message);
    }
  }
  return rows.length;
}
