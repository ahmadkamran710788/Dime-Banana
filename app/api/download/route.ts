import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "@/lib/db";
import { s3 } from "@/lib/s3";

export const dynamic = "force-dynamic";

// Default: 302-redirect to a presigned S3 URL with an attachment disposition.
// The browser downloads straight from S3, so even 4K files (7 MB+) work —
// streaming them through this function would exceed Vercel's 4.5 MB response cap.
// ?inline=1: stream the bytes same-origin (used by "Use as input" to read the
// result back; fine for 1K/2K, may exceed the function cap for 4K on Vercel).
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
    if (!imageKey) {
      return NextResponse.json({ error: "Image is not ready yet." }, { status: 409 });
    }
    const ext = (mimeType || "image/jpeg").split("/")[1] || "jpg";
    const filename = `nano-banana-${id.slice(0, 8)}.${ext}`;

    if (req.nextUrl.searchParams.get("inline") === "1") {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME!, Key: imageKey })
      );
      const bytes = await obj.Body!.transformToByteArray();
      return new NextResponse(Buffer.from(bytes), {
        headers: { "Content-Type": mimeType || "image/jpeg" },
      });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME!,
        Key: imageKey,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: 300 }
    );
    return NextResponse.redirect(url, 302);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Download failed." }, { status: 500 });
  }
}
