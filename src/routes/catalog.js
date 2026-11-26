import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../lib/errors.js';
import { getProduct, homepage, listCategories, listProducts } from '../services/catalog.js';
import { query } from '../lib/db.js';

const r = Router();

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20) : undefined);
const euroToCents = (v) => (v === undefined || v === '' ? undefined : Math.round(Number(v) * 100));

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().regex(/^[a-z0-9-]+$/).max(60).optional(),
  size: z.string().max(100).optional(),
  color: z.string().max(200).optional(),
  minPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  maxPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'popular', 'price_asc', 'price_desc']).optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
});

r.get('/products', ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  res.set('Cache-Control', 'public, max-age=30');
  res.json(await listProducts({
    q: q.q || undefined,
    category: q.category,
    sizes: list(q.size),
    colors: list(q.color),
    minPrice: euroToCents(q.minPrice),
    maxPrice: euroToCents(q.maxPrice),
    inStock: q.inStock === 'true',
    featured: q.featured === 'true',
    sort: q.sort,
    page: q.page,
    limit: q.limit,
  }));
}));

r.get('/products/:slug', ah(async (req, res) => {
  const slug = z.string().regex(/^[a-z0-9-]+$/).max(120).parse(req.params.slug);
  res.set('Cache-Control', 'public, max-age=30');
  res.json(await getProduct(slug));
}));

r.get('/categories', ah(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  res.json(await listCategories());
}));

r.get('/home', ah(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await homepage());
}));

r.get('/shipping-methods', ah(async (req, res) => {
  const country = z.string().length(2).toUpperCase().optional().parse(req.query.country);
  const { rows } = await query(
    `SELECT code, name, carrier, price, free_over AS "freeOver", min_days AS "minDays", max_days AS "maxDays", countries
     FROM shipping_methods WHERE active AND ($1::text IS NULL OR cardinality(countries) = 0 OR $1 = ANY(countries))
     ORDER BY position`, [country ?? null]);
  res.json(rows);
}));

export default r;
