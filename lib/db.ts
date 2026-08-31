import { Pool } from "pg";

// Shared RDS instance — keep the pool tiny: connections are shared with the
// main Dime Droppers backend and its workers.
const globalForDb = globalThis as unknown as { pgPool?: Pool };

export const db =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: false },
  });

if (process.env.NODE_ENV !== "production") globalForDb.pgPool = db;
