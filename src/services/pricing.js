import { query } from '../lib/db.js';
import { loadLines } from './cart.js';

/**
 * Checks a coupon against the cart lines.
 * Returns { coupon, valid, error, eligibleSubtotal }.
 */
export async function evaluateCoupon(code, lines, subtotal, db = { query }, { lock = false } = {}) {
  if (!code) return null;
  const { rows } = await db.query(
    `SELECT id, code, type, value, min_subtotal, starts_at, expires_at, usage_limit, used_count, product_ids, category_ids, active
     FROM coupons WHERE code = $1 ${lock ? 'FOR UPDATE' : ''}`, [code.toUpperCase()]);
  const c = rows[0];
  const fail = (error) => ({ code: code.toUpperCase(), valid: false, error });
  if (!c || !c.active) return fail('NOT_FOUND');
  const now = new Date();
  if (c.starts_at && c.starts_at > now) return fail('NOT_STARTED');
  if (c.expires_at && c.expires_at < now) return fail('EXPIRED');
  if (c.usage_limit != null && c.used_count >= c.usage_limit) return fail('USAGE_LIMIT');
  if (c.min_subtotal != null && subtotal < c.min_subtotal) {
    return { ...fail('MIN_SUBTOTAL'), minSubtotal: c.min_subtotal };
  }
  const restricted = c.product_ids.length || c.category_ids.length;
  const eligible = lines.filter((l) => !restricted
    || c.product_ids.includes(l.productId)
    || l.categoryIds.some((id) => c.category_ids.includes(id)));
  const eligibleSubtotal = eligible.reduce((s, l) => s + l.lineTotal, 0);
  if (c.type !== 'FREE_SHIPPING' && eligibleSubtotal === 0) return fail('NOT_APPLICABLE');
  return { id: c.id, code: c.code, type: c.type, value: c.value, valid: true, eligibleSubtotal };
}

export function couponDiscount(coupon) {
  if (!coupon?.valid) return 0;
  if (coupon.type === 'PERCENT') return Math.round((coupon.eligibleSubtotal * coupon.value) / 100);
  if (coupon.type === 'FIXED') return Math.min(coupon.value, coupon.eligibleSubtotal);
  return 0;
}

export async function shippingOptions(country, subtotal, freeShipping, db = { query }) {
  const { rows } = await db.query(
    `SELECT id, code, name, carrier, price, free_over, min_days, max_days FROM shipping_methods
     WHERE active AND (cardinality(countries) = 0 OR $1 = ANY(countries)) ORDER BY position`, [country]);
  return rows.map((m) => {
    const free = freeShipping || (m.free_over != null && subtotal >= m.free_over);
    return {
      id: m.id, code: m.code, name: m.name, carrier: m.carrier,
      price: free ? 0 : m.price, regularPrice: m.price, freeOver: m.free_over,
      minDays: m.min_days, maxDays: m.max_days,
    };
  });
}

/**
 * Full cart calculation. Everything is recomputed from the database — the browser never supplies prices.
 */
export async function priceCart(cart, { country = 'NL', shipping } = {}, db = { query }, opts = {}) {
  const lines = await loadLines(cart.id, db, opts);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const coupon = await evaluateCoupon(cart.coupon_code, lines, subtotal, db, opts);
  const discount = couponDiscount(coupon);
  const freeShipping = coupon?.valid && coupon.type === 'FREE_SHIPPING';
  // Free-shipping thresholds apply to the amount after discount.
  const options = await shippingOptions(country, subtotal - discount, freeShipping, db);
  const selected = options.find((o) => o.code === shipping) || options[0] || null;
  const shippingCost = selected ? selected.price : 0;
  const hasIssues = lines.some((l) => l.issue);
  return {
    lines,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    coupon: coupon && { code: coupon.code, valid: coupon.valid, error: coupon.error, type: coupon.type, value: coupon.value, minSubtotal: coupon.minSubtotal },
    couponRaw: coupon,
    discount,
    country,
    shippingOptions: options,
    shipping: selected,
    shippingCost,
    total: Math.max(0, subtotal - discount + shippingCost),
    currency: 'EUR',
    canCheckout: lines.length > 0 && !hasIssues && Boolean(selected),
  };
}

/** Public shape (drops internal fields). */
export function publicCart(token, priced) {
  // eslint-disable-next-line no-unused-vars
  const { couponRaw, ...rest } = priced;
  return {
    token,
    ...rest,
    lines: rest.lines.map(({ productId, categoryIds, ...l }) => l),
  };
}
