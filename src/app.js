import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { errorHandler } from './lib/errors.js';
import catalog from './routes/catalog.js';
import cart from './routes/cart.js';
import checkout from './routes/checkout.js';
import misc from './routes/misc.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  // JSON API: a CSP adds nothing, but the other helmet headers do.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'X-Cart-Token'], maxAge: 600 }));
  app.use(express.json({ limit: '50kb' }));

  const limiter = (max, windowMin = 15) => rateLimit({
    windowMs: windowMin * 60 * 1000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
  });
  app.use('/api', limiter(600));
  app.use('/api/checkout', limiter(20));
  app.use('/api/orders/lookup', limiter(10));
  app.use('/api/newsletter', limiter(10));

  app.use('/images', express.static(path.join(publicDir, 'images'), { maxAge: '7d', immutable: false, fallthrough: false }));

  app.use('/api', misc);
  app.use('/api', catalog);
  app.use('/api', cart);
  app.use('/api', checkout);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint not found' }));
  app.use(errorHandler);
  return app;
}
