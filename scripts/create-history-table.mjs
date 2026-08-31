// Idempotent, additive-only setup for this app's history table on the shared RDS.
// Safe to re-run: every statement is IF NOT EXISTS. Never touches existing tables.
// Run with: node scripts/create-history-table.mjs
import { readFileSync } from "node:fs";
import pg from "pg";

// Load .env.local (no dotenv dependency needed)
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

const SQL = `
CREATE TABLE IF NOT EXISTS "NanoBananaHistory" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "prompt"          TEXT NOT NULL,
  "model"           TEXT NOT NULL,
  "imageKey"        TEXT NOT NULL,
  "mimeType"        TEXT NOT NULL DEFAULT 'image/jpeg',
  "inputImageCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "NanoBananaHistory_createdAt_idx"
  ON "NanoBananaHistory"("createdAt" DESC);
`;

try {
  // sanity check we're on the right database first
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM "School"');
  console.log(`Connected — School table has ${rows[0].n} rows (expect ~48k)`);
  for (const stmt of SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
  console.log('Table "NanoBananaHistory" is ready.');
} finally {
  await pool.end();
}
