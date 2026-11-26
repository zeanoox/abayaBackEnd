import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';

export const MAX_LINE_QTY = 20;

export const newToken = () => crypto.randomBytes(24).toString('base64url');

export async function createCart() {
  const { rows } = await query('INSERT INTO carts (token) VALUES ($1) RETURNING id, token', [newToken()]);
  return rows[0];
}

export async function findCart(token, db = { query }) {
  if (!token || typeof token !== 'string' || token.length > 64) throw notFound('Cart');
  const { rows } = await db.query('SELECT id, token, coupon_code, pending_order_id FROM carts WHERE token = $1', [token]);
  if (!rows[0]) throw notFound('Cart');
  return rows[0];
}

const touch = (cartId) => query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);

async function sellableVariant(variantId) {
  const { rows } = await query(
    `SELECT v.id, v.stock FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.id = $1 AND v.active AND p.status = 'ACTIVE'`, [variantId]);
  if (!rows[0]) throw new HttpError(404, 'VARIANT_UNAVAILABLE', 'This option is not available');
  return rows[0];
}

export async function addItem(cart, variantId, quantity) {
  const v = await sellableVariant(variantId);
  const { rows } = await query('SELECT quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2', [cart.id, variantId]);
  const wanted = (rows[0]?.quantity || 0) + quantity;
  if (v.stock <= 0) throw new HttpError(409, 'OUT_OF_STOCK', 'This option is sold out', { available: 0 });
  if (wanted > Math.min(v.stock, MAX_LINE_QTY)) {
    throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock', { available: Math.min(v.stock, MAX_LINE_QTY) });
  }
  await query(
    `INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,$3)
     ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = $3`, [cart.id, variantId, wanted]);
  await touch(cart.id);
}

export async function setItemQty(cart, itemId, quantity) {
  const { rows } = await query('SELECT variant_id FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cart.id]);
  if (!rows[0]) throw notFound('Cart item');
  if (quantity === 0) return removeItem(cart, itemId);
  const v = await sellableVariant(rows[0].variant_id);
  if (quantity > Math.min(v.stock, MAX_LINE_QTY)) {
    throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock', { available: Math.min(v.stock, MAX_LINE_QTY) });
  }
  await query('UPDATE cart_items SET quantity = $1 WHERE id = $2', [quantity, itemId]);
  await touch(cart.id);
}

export async function removeItem(cart, itemId) {
  await query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cart.id]);
  await touch(cart.id);
}

export async function setCoupon(cart, code) {
  await query('UPDATE carts SET coupon_code = $1, updated_at = now() WHERE id = $2', [code ? code.toUpperCase() : null, cart.id]);
}

/** Loads cart lines with live product data. `lock` = SELECT ... FOR UPDATE on variants (checkout). */
export async function loadLines(cartId, db = { query }, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT ci.id, ci.quantity, v.id AS variant_id, v.sku, v.stock, v.active AS v_active, v.length_inch,
       v.price_override, s.code AS size, c.code AS color_code, c.name AS color_name, c.hex AS color_hex,
       p.id AS product_id, p.slug, p.name, p.price, p.sale_price, p.status,
       (SELECT array_agg(pc.category_id) FROM product_categories pc WHERE pc.product_id = p.id) AS category_ids,
       (SELECT i.url FROM product_images i WHERE i.product_id = p.id
          ORDER BY (i.color_id IS NOT DISTINCT FROM v.color_id) DESC, i.position LIMIT 1) AS image
     FROM cart_items ci
     JOIN product_variants v ON v.id = ci.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN sizes s ON s.id = v.size_id
     LEFT JOIN colors c ON c.id = v.color_id
     WHERE ci.cart_id = $1
     ORDER BY v.id
     ${lock ? 'FOR UPDATE OF v' : ''}`, [cartId]);

  return rows.map((r) => {
    const unitPrice = r.price_override ?? r.sale_price ?? r.price;
    let issue = null;
    if (r.status !== 'ACTIVE' || !r.v_active) issue = 'UNAVAILABLE';
    else if (r.stock <= 0) issue = 'OUT_OF_STOCK';
    else if (r.stock < r.quantity) issue = 'INSUFFICIENT_STOCK';
    return {
      id: r.id,
      variantId: r.variant_id,
      productId: r.product_id,
      categoryIds: r.category_ids || [],
      quantity: r.quantity,
      product: { slug: r.slug, name: r.name },
      variant: {
        sku: r.sku,
        size: r.size,
        length: r.length_inch,
        color: r.color_code ? { code: r.color_code, name: r.color_name, hex: r.color_hex } : null,
      },
      image: r.image,
      unitPrice,
      compareAt: r.price_override == null && r.sale_price != null ? r.price : null,
      lineTotal: unitPrice * r.quantity,
      available: Math.max(0, Math.min(r.stock, MAX_LINE_QTY)),
      issue,
    };
  });
}

/** Human-readable variant label stored on order lines, e.g. "M · Zwart · 56"". */
export function variantLabel(line, lang = 'en') {
  const v = line.variant;
  return [v.size && v.size !== 'OS' ? v.size : null, v.color?.name?.[lang] ?? v.color?.code, v.length ? `${v.length}"` : null]
    .filter(Boolean).join(' · ');
}
