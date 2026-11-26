import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../lib/errors.js';
import { query } from '../lib/db.js';

const r = Router();

r.get('/health', ah(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));

r.post('/newsletter', ah(async (req, res) => {
  const { email, locale } = z.object({
    email: z.string().trim().email().max(200),
    locale: z.enum(['nl', 'en', 'ar']).default('nl'),
  }).parse(req.body);
  await query(
    `INSERT INTO newsletter_subscribers (email, locale) VALUES ($1,$2) ON CONFLICT ((lower(email))) DO NOTHING`,
    [email.toLowerCase(), locale]);
  // Same answer whether or not the address was already subscribed (no e-mail enumeration).
  res.status(201).json({ ok: true });
}));

export default r;
