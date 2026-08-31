import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { s3 } from "@/lib/s3";

export const dynamic = "force-dynamic";

// Streams a history result image with an attachment header so the browser
// saves it instead of opening it (the download attribute is ignored on
// cross-origin presigned URLs).
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { rows } = await db.query(
      `SELECT "imageKey", "mimeType" FROM "NanoBananaHistory" WHERE "id" = $1`,
      [id]
    );
    if (!rows[0]) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const { imageKey, mimeType } = rows[0];
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME!, Key: imageKey })
    );
    const bytes = await obj.Body!.transformToByteArray();

    const ext = (mimeType || "image/jpeg").split("/")[1] || "jpg";
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": mimeType || "image/jpeg",
        "Content-Disposition": `attachment; filename="nano-banana-${id.slice(0, 8)}.${ext}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Download failed." }, { status: 500 });
  }
}
