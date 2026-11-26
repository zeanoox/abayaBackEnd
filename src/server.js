import express from 'express';
import cors from 'cors';
import { products, categories } from './data.js';

const app = express();
const PORT = process.env.PORT || 4000;
const LANGS = ['nl', 'en', 'ar'];

// Comma-separated list of allowed frontend origins, e.g.
// CORS_ORIGIN=http://localhost:5173,https://abayafrontend.example.workers.dev
const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim());
app.use(cors({ origin: origins }));
app.use(express.json());

// ?lang=nl|en|ar flattens { nl, en, ar } fields to plain strings; without it, all languages are returned.
function localize(item, lang) {
  if (!LANGS.includes(lang)) return item;
  const out = { ...item };
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && lang in v) out[k] = v[lang];
  }
  return out;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/categories', (req, res) => {
  res.json(categories.map((c) => localize(c, req.query.lang)));
});

app.get('/api/products', (req, res) => {
  const { category, inStock, lang } = req.query;
  let list = products;
  if (category) list = list.filter((p) => p.category === category);
  if (inStock === 'true') list = list.filter((p) => !p.soldOut);
  res.json(list.map((p) => localize(p, lang)));
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find((p) => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(localize(product, req.query.lang));
});

// Validates the cart against the catalogue and returns a server-calculated total.
app.post('/api/orders', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
  let total = 0;
  const lines = [];
  for (const { id, qty } of items) {
    const p = products.find((x) => x.id === Number(id));
    if (!p || !Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: `Invalid item ${id}` });
    if (p.soldOut) return res.status(409).json({ error: `Product ${p.code} is sold out` });
    total += p.price * qty;
    lines.push({ id: p.id, code: p.code, qty, price: p.price });
  }
  res.status(201).json({
    orderId: `LR-${Date.now()}`,
    lines,
    total: Math.round(total * 100) / 100,
    currency: 'EUR',
    status: 'pending',
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`LORIM API running on http://localhost:${PORT}`));
