# LORIM – Shop Backend

Node.js + Express + PostgreSQL API for the LORIM abaya shop.
Frontend: [abayaFrontEnd](https://github.com/zeanoox/abayaFrontEnd).

**Status: phase 1 + 2 done** — catalogue, variants and stock, server-side cart, discount codes, shipping,
checkout, Mollie payments with server-side verification, order status. Next: admin dashboard (phase 3),
customer accounts, e-mails, reviews and returns (phase 4).

## Quick start (local)

Requirements: Node 20+, PostgreSQL 15+.

```bash
cp .env.example .env            # then edit DATABASE_URL
npm install
npm run db:setup                # create tables + load the starter catalogue
npm run dev                     # http://localhost:4000
```

To try the whole checkout without a Mollie account, set `PAYMENT_PROVIDER=mock` in `.env`.
The "payment page" then lets you choose *pay / fail / cancel*. The mock provider refuses to start when `NODE_ENV=production`.

### Tests

```bash
createdb lorim_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lorim_test npm test
```

17 end-to-end tests run against a real database, including: overselling under concurrent checkouts,
duplicate webhooks, failed/abandoned payments releasing stock, late payments, coupon limits and price tampering.

## Environment variables

| Variable | Example | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://…` | PostgreSQL 15+ |
| `DATABASE_SSL` | `true` | for hosted databases (Render, Supabase, Railway) |
| `PORT` | `4000` | |
| `NODE_ENV` | `production` | |
| `API_PUBLIC_URL` | `https://api.lorim.nl` | Mollie sends webhooks here — must be public HTTPS |
| `FRONTEND_URL` | `https://lorim.nl` | customers return here after paying |
| `CORS_ORIGIN` | `https://lorim.nl,https://abayafrontend.xyz.workers.dev` | comma-separated |
| `PAYMENT_PROVIDER` | `mollie` | `mock` only for local testing |
| `MOLLIE_API_KEY` | `test_…` / `live_…` | **secret** — set in the host's dashboard, never commit |
| `ORDER_RESERVATION_MINUTES` | `60` | unpaid orders give their stock back after this |
| `AUTO_MIGRATE` | `true` | run migrations on start-up |
| `TRUST_PROXY` | `1` | number of proxies in front of the app (for rate limiting) |

## Deploying (example: Render)

1. Create a **PostgreSQL** database on Render. Copy its *Internal Database URL*.
2. Create a **Web Service** from this repo:
   - Build command: `npm ci`
   - Start command: `npm start`
   - Environment: the variables above, with `AUTO_MIGRATE=true` and `DATABASE_SSL=true`.
3. After the first deploy, open the Render shell once and run `npm run db:seed` to load the starter catalogue.
4. In the frontend (Cloudflare), set `VITE_API_URL=https://<your-api>.onrender.com/api` and redeploy.
5. Add your Mollie **test** key, place a test order, then switch to the `live_` key when Mollie approves your account.

Railway, Fly.io or a VPS work the same way (Node 20 + PostgreSQL).

## How payments stay safe

- The browser never sends prices: the cart, discounts and shipping are recalculated from the database at checkout.
- Stock is reserved in one transaction with a guarded `UPDATE … WHERE stock >= qty`, so the last item can't be sold twice.
- An order is **only** marked paid after the backend asks Mollie for the payment status (webhook, order page refresh or
  the expiry job). Landing on the "thank you" page changes nothing.
- Failed, cancelled and expired payments release the stock; a payment that arrives after the reservation expired
  re-reserves it, or flags the order for a refund if the item is gone.
- Card data never touches this server (Mollie hosts the payment page).
- helmet headers, CORS allow-list, rate limits on checkout/lookup, zod validation on every input, parameterised SQL only.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/home` | featured, new arrivals, best sellers, categories |
| GET | `/api/products` | `q`, `category`, `size`, `color`, `minPrice`, `maxPrice`, `inStock`, `sort` (`newest`/`popular`/`price_asc`/`price_desc`), `page`, `limit` → items + facets |
| GET | `/api/products/:slug` | details, images, variants, related |
| GET | `/api/categories` | tree incl. smart collections `new-arrivals` and `sale` |
| GET | `/api/shipping-methods?country=NL` | |
| POST | `/api/cart` | create cart → `token` |
| GET | `/api/cart?country=&shipping=` | header `X-Cart-Token` |
| POST | `/api/cart/items` | `{ variantId, quantity }` |
| PATCH/DELETE | `/api/cart/items/:id` | |
| POST/DELETE | `/api/cart/coupon` | `{ code }` |
| POST | `/api/checkout` | customer + address + shipping → order + Mollie `checkoutUrl` |
| GET | `/api/orders/:number?token=` | order status (refreshes payment from Mollie while pending) |
| POST | `/api/orders/lookup` | `{ number, email }` for guests |
| POST | `/api/payments/webhook` | Mollie webhook |
| POST | `/api/newsletter` | `{ email, locale }` |
| GET | `/api/health` | |

Translatable fields come back as `{ "nl": "…", "en": "…", "ar": "…" }`. Money is in cents.

## Database

`db/migrations/001_init.sql` — users, addresses, categories, products, product_images, product_variants
(size × colour × length, own SKU + stock), stock_adjustments (history), carts, cart_items, shipping_methods,
coupons, orders, order_items (snapshot of name/SKU/variant/price), order_events, payments, shipments,
newsletter_subscribers. Add new changes as `002_….sql`, `003_….sql`; `npm run db:migrate` applies them once each.

Starter discount codes: `WELKOM10` (10% from €50), `GRATISVERZENDING`, `EID15` (€15 off from €100).
Product images in `public/images/products` are generated placeholders until real photos are uploaded.
