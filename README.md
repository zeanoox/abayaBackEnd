# LORIM – Shop Backend

Express API for the LORIM abaya shop (frontend: [abayaFrontEnd](https://github.com/zeanoox/abayaFrontEnd)).
Starter version with in-memory data; product and category names are available in Dutch, English and Arabic.

## Run

```bash
npm install
npm run dev        # http://localhost:4000
```

| Env var | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated list of allowed frontend URLs |

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | health check |
| GET | `/api/categories?lang=` | all categories |
| GET | `/api/products?category=&inStock=true&lang=` | list / filter products |
| GET | `/api/products/:id?lang=` | single product |
| POST | `/api/orders` | body `{ items: [{ id, qty }] }` → validated lines + total (EUR) |

`lang` is `nl`, `en` or `ar`. Leave it out to get every language as `{ nl, en, ar }` (this is what the frontend uses, so it can switch language without refetching).

## Connect the frontend

In the frontend, create `.env` with `VITE_API_URL=http://localhost:4000/api`.

## Next steps

Database (PostgreSQL/MongoDB), admin product management, customer accounts, payments (e.g. Mollie for iDEAL in the Netherlands).
