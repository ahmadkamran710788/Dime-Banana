import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { imageUrl, deleteImage } from "@/lib/s3";

export const dynamic = "force-dynamic";

// Background jobs run inside the generate function's maxDuration (300s).
// Anything still pending well past that was killed mid-flight.
const STALE_AFTER = "6 minutes";

const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 60;

// GET /api/history            -> newest page
// GET /api/history?cursor=<id> -> the page after that item (keyset paging on
//                                 createdAt+id, so new rows arriving at the
//                                 top never shift older pages)
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const cursor = params.get("cursor");
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(params.get("limit")) || PAGE_SIZE)
    );

    await db.query(
      `UPDATE "NanoBananaHistory"
          SET "status" = 'failed',
              "error" = 'Timed out — the server stopped before this generation finished.'
        WHERE "status" = 'pending'
          AND "createdAt" < now() - interval '${STALE_AFTER}'`
    );

    // one extra row tells us whether another page exists
    const { rows: page } = cursor
      ? await db.query(
          `SELECT "id", "prompt", "model", "imageKey", "thumbKey", "mimeType", "inputImageCount",
                  "inputImageKeys", "resolution", "createdAt", "status", "error"
           FROM "NanoBananaHistory"
           WHERE ("createdAt", "id") < (
             SELECT "createdAt", "id" FROM "NanoBananaHistory" WHERE "id" = $1
           )
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT $2`,
          [cursor, limit + 1]
        )
      : await db.query(
          `SELECT "id", "prompt", "model", "imageKey", "thumbKey", "mimeType", "inputImageCount",
                  "inputImageKeys", "resolution", "createdAt", "status", "error"
           FROM "NanoBananaHistory"
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT $1`,
          [limit + 1]
        );
    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS "total" FROM "NanoBananaHistory"`
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
        // older rows have no thumbnail yet — fall back to the full image
        thumbUrl: r.thumbKey
          ? await imageUrl(r.thumbKey)
          : r.imageKey
            ? await imageUrl(r.imageKey)
            : null,
        inputUrls: await Promise.all(
          (r.inputImageKeys ?? []).map((k: string) => imageUrl(k))
        ),
      }))
    );
    return NextResponse.json({ items, hasMore, total: countRows[0]?.total ?? items.length });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Could not load history." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { rows } = await db.query(
      `DELETE FROM "NanoBananaHistory" WHERE "id" = $1
       RETURNING "imageKey", "thumbKey", "inputImageKeys"`,
      [id]
    );
    if (rows[0]) {
      const keys = [rows[0].imageKey, rows[0].thumbKey, ...(rows[0].inputImageKeys ?? [])].filter(
        Boolean
      );
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
