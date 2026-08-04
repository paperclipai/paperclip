import pg from 'pg';

const { Pool } = pg;

// Accepts DATABASE_URL (full connection string) or individual PG* env vars
// which pg reads automatically (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
export const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined,
);
