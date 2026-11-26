import { query } from '../lib/db.js';
import { config } from '../lib/config.js';
import { notFound } from '../lib/errors.js';

const SMART = new Set(['new-arrivals', 'sale']);
const EFFECTIVE_PRICE = 'COALESCE(p.sale_price, p.price)';

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Builds the WHERE clause for product listing. `skip` lets facet queries ignore a filter
 * (so the size list still shows every size while one size is selected, etc.).
 */
function buildWhere(f, skip = {}) {
  const where = [`p.status = 'ACTIVE'`];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };

  if (f.category && !skip.category) {
    if (f.category === 'new-arrivals') {
      where.push(`p.published_at >= now() - make_interval(days => ${add(config.newArrivalDays)})`);
    } else if (f.category === 'sale') {
      where.push('p.sale_price IS NOT NULL');
    } else {
      // Category and its direct children.
      where.push(`EXISTS (SELECT 1 FROM product_categories pc JOIN categories c ON c.id = pc.category_id
        WHERE pc.product_id = p.id AND c.active AND (c.slug = ${add(f.category)}
          OR c.parent_id = (SELECT id FROM categories WHERE slug = $${params.length})))`);
    }
  }
  if (f.q) {
    const like = add(`%${escapeLike(f.q.toLowerCase())}%`);
    where.push(`(p.search_text LIKE ${like} OR EXISTS (SELECT 1 FROM product_variants v
      WHERE v.product_id = p.id AND lower(v.sku) LIKE ${like}))`);
  }
  if (f.minPrice != null && !skip.price) where.push(`${EFFECTIVE_PRICE} >= ${add(f.minPrice)}`);
  if (f.maxPrice != null && !skip.price) where.push(`${EFFECTIVE_PRICE} <= ${add(f.maxPrice)}`);

  // Size / colour / availability all have to be satisfied by the *same* variant.
  const vConds = [];
  if (f.sizes?.length && !skip.size) vConds.push(`s.code = ANY(${add(f.sizes)})`);
  if (f.colors?.length && !skip.color) vConds.push(`co.code = ANY(${add(f.colors)})`);
  if (f.inStock && !skip.stock) vConds.push('v.stock > 0');
  if (vConds.length) {
    where.push(`EXISTS (SELECT 1 FROM product_variants v
      LEFT JOIN sizes s ON s.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
      WHERE v.product_id = p.id AND v.active AND ${vConds.join(' AND ')})`);
  }
  if (f.featured) where.push('p.is_featured');
  return { where: where.join(' AND '), params, add };
}

const SORTS = {
  newest: 'p.published_at DESC NULLS LAST, p.id',
  popular: 'p.sales_count DESC, p.id',
  price_asc: `${EFFECTIVE_PRICE} ASC, p.id`,
  price_desc: `${EFFECTIVE_PRICE} DESC, p.id`,
};

// Columns + aggregates used by product cards.
const CARD_SELECT = `
  p.id, p.slug, p.sku, p.name, p.price, p.sale_price, p.is_featured, p.published_at, p.sales_count,
  (p.published_at >= now() - make_interval(days => ${Number(config.newArrivalDays)})) AS is_new,
  (SELECT COALESCE(json_agg(json_build_object('url', i.url, 'alt', i.alt, 'color', ic.code) ORDER BY i.position), '[]')
     FROM product_images i LEFT JOIN colors ic ON ic.id = i.color_id WHERE i.product_id = p.id) AS images,
  (SELECT COALESCE(json_agg(json_build_object('code', c.code, 'hex', c.hex, 'name', c.name,
       'inStock', x.in_stock) ORDER BY c.position), '[]')
     FROM (SELECT v.color_id, bool_or(v.stock > 0) AS in_stock FROM product_variants v
           WHERE v.product_id = p.id AND v.active AND v.color_id IS NOT NULL GROUP BY v.color_id) x
     JOIN colors c ON c.id = x.color_id) AS colors,
  (SELECT COALESCE(sum(v.stock), 0) FROM product_variants v WHERE v.product_id = p.id AND v.active) AS total_stock`;

export function toCard(r) {
  const images = r.images || [];
  return {
    id: r.id,
    slug: r.slug,
    sku: r.sku,
    name: r.name,
    price: r.price,
    salePrice: r.sale_price,
    image: images[0] || null,
    hoverImage: images[1] || null,
    images,
    colors: r.colors,
    inStock: r.total_stock > 0,
    isNew: Boolean(r.is_new),
    onSale: r.sale_price != null,
    featured: r.is_featured,
  };
}

export async function listProducts(f) {
  const limit = Math.min(Math.max(f.limit || 12, 1), 48);
  const page = Math.max(f.page || 1, 1);
  const { where, params } = buildWhere(f);
  const sort = SORTS[f.sort] || SORTS.newest;

  const [items, count] = await Promise.all([
    query(`SELECT ${CARD_SELECT} FROM products p WHERE ${where} ORDER BY ${sort} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    query(`SELECT count(*)::int AS n FROM products p WHERE ${where}`, params),
  ]);
  const total = count.rows[0].n;
  return {
    items: items.rows.map(toCard),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    facets: await facets(f),
  };
}

/** Options to show in the filter panel, based on the current category/search. */
async function facets(f) {
  const sizeW = buildWhere(f, { size: true });
  const colorW = buildWhere(f, { color: true });
  const priceW = buildWhere(f, { price: true });
  const [sizes, colors, price] = await Promise.all([
    query(`SELECT s.code, count(DISTINCT p.id)::int AS count FROM products p
      JOIN product_variants v ON v.product_id = p.id AND v.active JOIN sizes s ON s.id = v.size_id
      WHERE ${sizeW.where} GROUP BY s.code, s.position ORDER BY s.position`, sizeW.params),
    query(`SELECT c.code, c.hex, c.name, count(DISTINCT p.id)::int AS count FROM products p
      JOIN product_variants v ON v.product_id = p.id AND v.active JOIN colors c ON c.id = v.color_id
      WHERE ${colorW.where} GROUP BY c.code, c.hex, c.name, c.position ORDER BY c.position`, colorW.params),
    query(`SELECT min(${EFFECTIVE_PRICE})::int AS min, max(${EFFECTIVE_PRICE})::int AS max FROM products p
      WHERE ${priceW.where}`, priceW.params),
  ]);
  return { sizes: sizes.rows, colors: colors.rows, price: price.rows[0] };
}

export async function getProduct(slug) {
  const { rows } = await query(
    `SELECT ${CARD_SELECT}, p.description, p.fabric, p.care, p.fit, p.length_info, p.seo_title, p.seo_desc,
       (SELECT COALESCE(json_agg(json_build_object('slug', c.slug, 'name', c.name) ORDER BY c.position), '[]')
          FROM product_categories pc JOIN categories c ON c.id = pc.category_id
          WHERE pc.product_id = p.id AND c.active) AS categories
     FROM products p WHERE p.slug = $1 AND p.status = 'ACTIVE'`, [slug]);
  const r = rows[0];
  if (!r) throw notFound('Product');

  const variants = await query(
    `SELECT v.id, v.sku, s.code AS size, c.code AS color, v.length_inch, v.price_override, v.stock, v.low_stock_at
     FROM product_variants v LEFT JOIN sizes s ON s.id = v.size_id LEFT JOIN colors c ON c.id = v.color_id
     WHERE v.product_id = $1 AND v.active
     ORDER BY c.position NULLS FIRST, s.position NULLS FIRST, v.length_inch NULLS FIRST`, [r.id]);

  const base = r.sale_price ?? r.price;
  return {
    ...toCard(r),
    description: r.description,
    fabric: r.fabric,
    care: r.care,
    fit: r.fit,
    lengthInfo: r.length_info,
    seoTitle: r.seo_title,
    seoDesc: r.seo_desc,
    categories: r.categories,
    sizes: [...new Set(variants.rows.map((v) => v.size).filter(Boolean))],
    lengths: [...new Set(variants.rows.map((v) => v.length_inch).filter(Boolean))].sort((a, b) => a - b),
    variants: variants.rows.map((v) => ({
      id: v.id,
      sku: v.sku,
      size: v.size,
      color: v.color,
      length: v.length_inch,
      price: v.price_override ?? base,
      compareAt: v.price_override == null && r.sale_price != null ? r.price : null,
      // Exact stock is not exposed; the shop only needs "how many can I add" up to a cap.
      available: Math.min(v.stock, 10),
      lowStock: v.stock > 0 && v.stock <= v.low_stock_at,
    })),
    related: await related(r.id),
  };
}

async function related(productId) {
  const { rows } = await query(
    `SELECT ${CARD_SELECT} FROM products p
     WHERE p.status = 'ACTIVE' AND p.id <> $1 AND EXISTS (
       SELECT 1 FROM product_categories a JOIN product_categories b ON a.category_id = b.category_id
       WHERE a.product_id = $1 AND b.product_id = p.id)
     ORDER BY p.sales_count DESC LIMIT 4`, [productId]);
  return rows.map(toCard);
}

export async function listCategories() {
  const { rows } = await query(
    `SELECT c.id, c.slug, c.name, c.description, c.image, c.position, p.slug AS parent,
       (SELECT count(DISTINCT pc.product_id)::int FROM product_categories pc JOIN products pr ON pr.id = pc.product_id
          WHERE pr.status = 'ACTIVE' AND (pc.category_id = c.id
            OR pc.category_id IN (SELECT id FROM categories WHERE parent_id = c.id))) AS product_count
     FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.active ORDER BY c.position`);
  const smart = await query(
    `SELECT count(*) FILTER (WHERE published_at >= now() - make_interval(days => $1))::int AS "new-arrivals",
            count(*) FILTER (WHERE sale_price IS NOT NULL)::int AS sale
     FROM products WHERE status = 'ACTIVE'`, [config.newArrivalDays]);
  return rows.map((c) => ({
    slug: c.slug, name: c.name, description: c.description, image: c.image,
    parent: c.parent, smart: SMART.has(c.slug),
    productCount: SMART.has(c.slug) ? smart.rows[0][c.slug] : c.product_count,
  }));
}

export async function homepage() {
  const card = (where, order, limit = 8) =>
    query(`SELECT ${CARD_SELECT} FROM products p WHERE p.status = 'ACTIVE' AND ${where} ORDER BY ${order} LIMIT ${limit}`)
      .then((r) => r.rows.map(toCard));
  const [featured, newArrivals, bestSellers, categories] = await Promise.all([
    card('p.is_featured', 'p.published_at DESC'),
    card('TRUE', 'p.published_at DESC'),
    card('TRUE', 'p.sales_count DESC'),
    listCategories(),
  ]);
  return { featured, newArrivals, bestSellers, categories };
}
