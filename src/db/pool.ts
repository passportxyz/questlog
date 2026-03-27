import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
    });
  }
  return pool;
}

export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
