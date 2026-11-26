# LORIM – Shop Backend

Express API for the LORIM abaya shop. Starter version with in-memory data.

## Run

```bash
npm install
npm run dev        # http://localhost:4000
```

Env vars: `PORT` (default 4000), `CORS_ORIGIN` (default `http://localhost:5173`).

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | health check |
| GET | `/api/categories` | all categories |
| GET | `/api/products?category=&isNew=true` | list / filter products |
| GET | `/api/products/:id` | single product |
| POST | `/api/orders` | body `{ items: [{ id, qty }] }` → returns total |

## Next steps

Database (e.g. PostgreSQL/MongoDB), admin product management, auth, payment gateway.
