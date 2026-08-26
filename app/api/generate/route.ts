import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

const MODELS: Record<string, string> = {
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2": "gemini-3.1-flash-image",
};

export async function POST(req: NextRequest) {
  try {
    const { prompt, model, images } = await req.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "A prompt is required." }, { status: 400 });
    }

    const modelId = MODELS[model];
    if (!modelId) {
      return NextResponse.json({ error: "Unknown model." }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Server is missing GEMINI_API_KEY." }, { status: 500 });
    }

    const parts: object[] = [];
    if (Array.isArray(images)) {
      for (const img of images) {
        if (img?.data && img?.mimeType) {
          parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
        }
      }
    }
    parts.push({ text: prompt });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      const message = data?.error?.message || "Generation failed.";
      return NextResponse.json({ error: message }, { status: res.status });
    }

    const outParts = data?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = outParts.find((p: any) => p.inlineData?.data);
    const textPart = outParts.find((p: any) => typeof p.text === "string");

    if (!imagePart) {
      return NextResponse.json(
        { error: textPart?.text || "The model returned no image." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      image: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
      text: textPart?.text ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unexpected server error." }, { status: 500 });
  }
}
