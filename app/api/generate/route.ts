import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { uploadResultImage, uploadInputImage, imageUrl } from "@/lib/s3";

export const maxDuration = 120;

type ImageInput = { data: string; mimeType: string };

const GEMINI_MODELS: Record<string, string> = {
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2": "gemini-3.1-flash-image",
};

async function generateGemini(
  modelId: string,
  prompt: string,
  images: ImageInput[],
  resolution: string
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: "Server is missing GEMINI_API_KEY.", status: 500 };

  const parts: object[] = images.map((img) => ({
    inline_data: { mime_type: img.mimeType, data: img.data },
  }));
  parts.push({ text: prompt });

  const body: Record<string, unknown> = { contents: [{ parts }] };
  if (resolution === "2K" || resolution === "4K") {
    body.generationConfig = { imageConfig: { imageSize: resolution } };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!res.ok) return { error: data?.error?.message || "Generation failed.", status: res.status };

  const outParts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = outParts.find((p: any) => p.inlineData?.data);
  const textPart = outParts.find((p: any) => typeof p.text === "string");
  if (!imagePart) return { error: textPart?.text || "The model returned no image.", status: 502 };

  return {
    image: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}

async function generateOpenAI(prompt: string, images: ImageInput[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: "Server is missing OPENAI_API_KEY.", status: 500 };

  let res: Response;
  if (images.length === 0) {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // JPEG output keeps the response under Vercel's 4.5 MB limit (PNGs can exceed it)
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt,
        size: "auto",
        output_format: "jpeg",
        output_compression: 90,
      }),
    });
  } else {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", prompt);
    form.append("output_format", "jpeg");
    form.append("output_compression", "90");
    images.forEach((img, i) => {
      const bytes = Buffer.from(img.data, "base64");
      const ext = img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg";
      form.append("image[]", new Blob([bytes], { type: img.mimeType }), `input-${i}.${ext}`);
    });
    res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  }

  const data = await res.json();
  if (!res.ok) return { error: data?.error?.message || "Generation failed.", status: res.status };

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) return { error: "The model returned no image.", status: 502 };
  return { image: b64, mimeType: "image/jpeg" };
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, model, images, resolution } = await req.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "A prompt is required." }, { status: 400 });
    }

    const imageList: ImageInput[] = Array.isArray(images)
      ? images.filter((img: any) => img?.data && img?.mimeType)
      : [];

    let result;
    if (model === "gpt-image-2") {
      result = await generateOpenAI(prompt, imageList);
    } else if (GEMINI_MODELS[model]) {
      result = await generateGemini(GEMINI_MODELS[model], prompt, imageList, resolution);
    } else {
      return NextResponse.json({ error: "Unknown model." }, { status: 400 });
    }

    if ("error" in result && result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status || 500 });
    }

    // Record in history (S3 + DB). Never fail the generation over a history hiccup.
    let historyId: string | null = null;
    let resultKey: string | null = null;
    try {
      const [key, inputKeys] = await Promise.all([
        uploadResultImage(Buffer.from(result.image!, "base64"), result.mimeType!),
        Promise.all(
          imageList.map((img) => uploadInputImage(Buffer.from(img.data, "base64"), img.mimeType))
        ),
      ]);
      resultKey = key;
      const { rows } = await db.query(
        `INSERT INTO "NanoBananaHistory"
           ("prompt", "model", "imageKey", "mimeType", "inputImageCount", "inputImageKeys")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING "id"`,
        [prompt, model, key, result.mimeType, imageList.length, inputKeys]
      );
      historyId = rows[0]?.id ?? null;
    } catch (histErr) {
      console.error("history save failed:", histErr);
    }

    // Vercel caps responses at 4.5 MB — 2K/4K results are far bigger than that
    // as base64, so large images are returned as a presigned S3 URL instead.
    if (result.image!.length > 3_000_000 && resultKey) {
      return NextResponse.json({
        url: await imageUrl(resultKey),
        mimeType: result.mimeType,
        id: historyId,
      });
    }
    return NextResponse.json({ image: result.image, mimeType: result.mimeType, id: historyId });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unexpected server error." }, { status: 500 });
  }
}
