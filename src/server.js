import express from 'express';
import cors from 'cors';
import { products, categories } from './data.js';

const app = express();
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: ORIGIN }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/categories', (_req, res) => res.json(categories));

app.get('/api/products', (req, res) => {
  const { category, isNew } = req.query;
  let list = products;
  if (category) list = list.filter((p) => p.category === category);
  if (isNew === 'true') list = list.filter((p) => p.isNew);
  res.json(list);
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find((p) => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// Placeholder order endpoint — validates items against the catalogue and returns a total.
app.post('/api/orders', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
  let total = 0;
  for (const { id, qty } of items) {
    const p = products.find((x) => x.id === Number(id));
    if (!p || !Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: `Invalid item ${id}` });
    total += p.price * qty;
  }
  res.status(201).json({ orderId: `LR-${Date.now()}`, total, status: 'pending' });
});

app.listen(PORT, () => console.log(`LORIM API running on http://localhost:${PORT}`));
