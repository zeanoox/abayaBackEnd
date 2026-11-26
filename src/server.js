import 'dotenv/config';
import { createApp } from './app.js';
import { config } from './lib/config.js';
import { pool } from './lib/db.js';
import { migrate } from '../db/migrate.js';
import { expireStaleOrders } from './services/orders.js';
import { payments } from './payments/index.js';

if (process.env.AUTO_MIGRATE === 'true') await migrate();
payments(); // fail fast on missing payment configuration

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`LORIM API on :${config.port} (${config.env})`);
});

// Release stock from orders that were never paid.
const timer = setInterval(() => {
  expireStaleOrders().catch((err) => console.error('[orders] expiry job failed', err));
}, 5 * 60 * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
