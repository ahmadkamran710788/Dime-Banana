import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { imageUrl, deleteImage } from "@/lib/s3";

export const dynamic = "force-dynamic";

// Background jobs run inside the generate function's maxDuration (300s).
// Anything still pending well past that was killed mid-flight.
const STALE_AFTER = "6 minutes";

export async function GET() {
  try {
    await db.query(
      `UPDATE "NanoBananaHistory"
          SET "status" = 'failed',
              "error" = 'Timed out — the server stopped before this generation finished.'
        WHERE "status" = 'pending'
          AND "createdAt" < now() - interval '${STALE_AFTER}'`
    );

    const { rows } = await db.query(
      `SELECT "id", "prompt", "model", "imageKey", "mimeType", "inputImageCount",
              "inputImageKeys", "resolution", "createdAt", "status", "error"
       FROM "NanoBananaHistory"
       ORDER BY "createdAt" DESC
       LIMIT 30`
    );
    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        prompt: r.prompt,
        model: r.model,
        mimeType: r.mimeType,
        inputImageCount: r.inputImageCount,
        resolution: r.resolution,
        createdAt: r.createdAt,
        status: r.status ?? "done",
        error: r.error ?? null,
        url: r.imageKey ? await imageUrl(r.imageKey) : null,
        inputUrls: await Promise.all(
          (r.inputImageKeys ?? []).map((k: string) => imageUrl(k))
        ),
      }))
    );
    return NextResponse.json({ items });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Could not load history." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { rows } = await db.query(
      `DELETE FROM "NanoBananaHistory" WHERE "id" = $1 RETURNING "imageKey", "inputImageKeys"`,
      [id]
    );
    if (rows[0]) {
      const keys = [rows[0].imageKey, ...(rows[0].inputImageKeys ?? [])].filter(Boolean);
      for (const key of keys) {
        try {
          await deleteImage(key);
        } catch (s3Err) {
          console.error("s3 delete failed:", s3Err);
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Could not delete." }, { status: 500 });
  }
}
