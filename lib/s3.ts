import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

const BUCKET = process.env.AWS_S3_BUCKET_NAME!;

export const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// App-specific folder so keys never collide with the main app's uploads.
const FOLDER = "nano-banana/results";

export async function uploadResultImage(buffer: Buffer, contentType: string): Promise<string> {
  const ext = contentType.split("/")[1] || "bin";
  const key = `${FOLDER}/${uuidv4()}.${ext}`;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType })
  );
  return key;
}

// Presigned GET for rendering — 1 hour, same as the main app.
export async function imageUrl(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: 3600,
  });
}

export async function deleteImage(key: string): Promise<void> {
  // Only ever delete inside our own folder — never touch the main app's objects.
  if (!key.startsWith(`${FOLDER}/`)) throw new Error("Refusing to delete outside app folder.");
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
