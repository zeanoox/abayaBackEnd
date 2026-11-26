// Seeds the starter catalogue and writes placeholder product images to public/images/products.
// Safe to re-run: it upserts by slug/code/sku and only sets stock for new variants.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, tx } from '../src/lib/db.js';
import { productSvg } from '../scripts/product-art.js';
import * as D from './seed-data.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imgDir = path.join(root, 'public', 'images', 'products');

// Deterministic pseudo-random so every seed run gives the same stock levels.
let s = 42;
const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);

const searchText = (p) => [p.sku, ...Object.values(p.name)].join(' ').toLowerCase();

export async function seed({ log = console.log } = {}) {
  await mkdir(imgDir, { recursive: true });

  await tx(async (c) => {
    const colorIds = {};
    for (const [i, col] of D.colors.entries()) {
      const { rows } = await c.query(
        `INSERT INTO colors (code, name, hex, position) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, hex = EXCLUDED.hex RETURNING id`,
        [col.code, col.name, col.hex, i]);
      colorIds[col.code] = rows[0].id;
    }
    const sizeIds = {};
    for (const [i, code] of D.sizes.entries()) {
      const { rows } = await c.query(
        `INSERT INTO sizes (code, position) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET position = EXCLUDED.position RETURNING id`,
        [code, i]);
      sizeIds[code] = rows[0].id;
    }

    const catIds = {};
    for (const cat of D.categories) {
      const { rows } = await c.query(
        `INSERT INTO categories (slug, name, description, position, parent_id, image) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           position = EXCLUDED.position, parent_id = EXCLUDED.parent_id RETURNING id`,
        [cat.slug, cat.name, cat.description, cat.pos, cat.parent ? catIds[cat.parent] : null, null]);
      catIds[cat.slug] = rows[0].id;
    }

    const now = Date.now();
    for (const p of D.products) {
      const published = new Date(now - p.daysAgo * 86400000);
      const { rows } = await c.query(
        `INSERT INTO products (slug, sku, name, description, fabric, care, fit, length_info, price, sale_price,
           status, is_featured, sales_count, search_text, published_at, created_at, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,$13,$14,$14,$15)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           fabric = EXCLUDED.fabric, care = EXCLUDED.care, fit = EXCLUDED.fit, length_info = EXCLUDED.length_info,
           price = EXCLUDED.price, sale_price = EXCLUDED.sale_price, is_featured = EXCLUDED.is_featured,
           search_text = EXCLUDED.search_text, updated_at = now()
         RETURNING id`,
        [p.slug, p.sku, p.name, p.description, p.fabric ?? null, p.care ?? null, p.fit ?? null,
          p.lengths ? D.lengthInfo : null, p.price, p.sale ?? null, Boolean(p.featured), p.sales,
          searchText(p), published, [p.kind]]);
      const pid = rows[0].id;

      await c.query('DELETE FROM product_categories WHERE product_id = $1', [pid]);
      for (const slug of p.cats) {
        await c.query('INSERT INTO product_categories (product_id, category_id) VALUES ($1,$2)', [pid, catIds[slug]]);
      }

      // Images: full view + detail per colour.
      await c.query('DELETE FROM product_images WHERE product_id = $1', [pid]);
      let pos = 0;
      for (const code of p.colors) {
        const col = D.colors.find((x) => x.code === code);
        for (const detail of [false, true]) {
          const file = `${p.slug}-${code}-${detail ? 2 : 1}.svg`;
          await writeFile(path.join(imgDir, file),
            productSvg({ kind: p.kind, style: p.style, color: col.hex, accent: D.accents[code], detail }));
          const alt = Object.fromEntries(Object.keys(p.name).map((l) => [l, `${p.name[l]} – ${col.name[l]}`]));
          await c.query(
            `INSERT INTO product_images (product_id, color_id, url, alt, position, width, height)
             VALUES ($1,$2,$3,$4,$5,600,800)`,
            [pid, colorIds[code], `/images/products/${file}`, alt, pos++]);
        }
      }

      // Variants: size × colour (× length for abayas).
      const sizes = p.kind === 'abaya' ? ['S', 'M', 'L', 'XL', 'XXL'] : ['OS'];
      const lengths = p.lengths ? D.LENGTHS : [null];
      for (const code of p.colors) {
        for (const size of sizes) {
          for (const len of lengths) {
            const sku = [p.sku, size, code.toUpperCase().slice(0, 3), len].filter(Boolean).join('-');
            const r = rand();
            const stock = r < 0.12 ? 0 : r < 0.25 ? 1 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 12);
            const ins = await c.query(
              `INSERT INTO product_variants (product_id, sku, size_id, color_id, length_inch, stock)
               VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sku) DO NOTHING RETURNING id`,
              [pid, sku, sizeIds[size], colorIds[code], len, stock]);
            if (ins.rows[0] && stock > 0) {
              await c.query(`INSERT INTO stock_adjustments (variant_id, delta, reason, note) VALUES ($1,$2,'INITIAL','seed')`,
                [ins.rows[0].id, stock]);
            }
          }
        }
      }
    }
    // Rania in black is fully sold out, so "sold out" can be seen and tested.
    await c.query(`UPDATE product_variants SET stock = 0
      WHERE sku LIKE 'LR-RANIA-%-BLA%'`);

    for (const [i, m] of D.shippingMethods.entries()) {
      await c.query(
        `INSERT INTO shipping_methods (code, name, carrier, price, free_over, min_days, max_days, countries, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, free_over = EXCLUDED.free_over,
           min_days = EXCLUDED.min_days, max_days = EXCLUDED.max_days, countries = EXCLUDED.countries`,
        [m.code, m.name, m.carrier, m.price, m.freeOver ?? null, m.min, m.max, m.countries, i]);
    }
    for (const cp of D.coupons) {
      await c.query(
        `INSERT INTO coupons (code, type, value, min_subtotal) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`,
        [cp.code, cp.type, cp.value, cp.minSubtotal ?? null]);
    }
  });

  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM product_variants) AS variants,
    (SELECT count(*) FROM product_images) AS images, (SELECT count(*) FROM categories) AS categories`);
  log(`seeded: ${JSON.stringify(rows[0])}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed().then(() => pool.end()).catch((err) => { console.error(err); process.exit(1); });
}
