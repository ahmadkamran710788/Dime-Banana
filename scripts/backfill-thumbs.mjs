// One-off: create thumbnails for history rows generated before thumbnails
// existed. Additive only (uploads a new object + fills "thumbKey"); safe to
// re-run — rows that already have a thumbnail are skipped.
// Run with: node scripts/backfill-thumbs.mjs
import { readFileSync } from "node:fs";
import pg from "pg";
import sharp from "sharp";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}

const BUCKET = process.env.AWS_S3_BUCKET_NAME;
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

try {
  const { rows } = await pool.query(
    `SELECT "id", "imageKey" FROM "NanoBananaHistory"
      WHERE "imageKey" IS NOT NULL AND "thumbKey" IS NULL AND "status" = 'done'
      ORDER BY "createdAt" DESC`
  );
  console.log(`${rows.length} row(s) need a thumbnail`);
  let ok = 0;
  for (const r of rows) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r.imageKey }));
      const full = Buffer.from(await obj.Body.transformToByteArray());
      const thumb = await sharp(full)
        .rotate()
        .resize({ width: 640, withoutEnlargement: true })
        .jpeg({ quality: 78, mozjpeg: true })
        .toBuffer();
      const key = `nano-banana/thumbs/${randomUUID()}.jpeg`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: thumb,
          ContentType: "image/jpeg",
          CacheControl: "public, max-age=31536000, immutable",
        })
      );
      await pool.query(`UPDATE "NanoBananaHistory" SET "thumbKey" = $2 WHERE "id" = $1`, [r.id, key]);
      ok++;
      console.log(`${r.id.slice(0, 8)}: ${(full.length / 1e6).toFixed(1)} MB -> ${(thumb.length / 1e3).toFixed(0)} KB`);
    } catch (err) {
      console.error(`${r.id.slice(0, 8)}: failed —`, err.message);
    }
  }
  console.log(`done: ${ok}/${rows.length}`);
} finally {
  await pool.end();
}
