import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { imageUrl, deleteImage } from "@/lib/s3";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { rows } = await db.query(
      `SELECT "id", "prompt", "model", "imageKey", "mimeType", "inputImageCount", "createdAt"
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
        createdAt: r.createdAt,
        url: await imageUrl(r.imageKey),
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
      `DELETE FROM "NanoBananaHistory" WHERE "id" = $1 RETURNING "imageKey"`,
      [id]
    );
    if (rows[0]?.imageKey) {
      try {
        await deleteImage(rows[0].imageKey);
      } catch (s3Err) {
        console.error("s3 delete failed:", s3Err);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Could not delete." }, { status: 500 });
  }
}
