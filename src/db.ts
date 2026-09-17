/**
 * Postgres connection for the backend. A single pooled client shared by all
 * requests; configured via DATABASE_URL with a local-dev default.
 */
import pg from "pg";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://stardex:stardex@localhost:5432/stardex";

export const pool = new pg.Pool({ connectionString, max: 10 });

/** True if the database answers a trivial query — used by /health. */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}

/** Run `work` in a transaction, rolling back if it throws. */
export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
