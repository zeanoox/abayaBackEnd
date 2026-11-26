import pg from 'pg';

// Return BIGINT/NUMERIC counts as JS numbers (all our values fit safely).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

/** Parameterised query helper. Never interpolate user input into SQL. */
export const query = (text, params) => pool.query(text, params);

/** Run `fn(client)` inside a transaction; rolls back on any error. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
