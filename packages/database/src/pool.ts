import { Pool } from "pg";

let pool: Pool | null = null;

/** Lazily creates a single shared connection pool from DATABASE_URL. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
