import { NextRequest, NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import {
  uploadResultImage,
  uploadInputImage,
  uploadThumbImage,
  makeThumbnail,
  deleteImage,
  getObjectBuffer,
} from "@/lib/s3";

// Covers the ~1s response AND the background job scheduled with after().
// On Vercel this needs Fluid Compute (default for new projects).
export const maxDuration = 300;

type ImageInput = { data: string; mimeType: string };

const GEMINI_MODELS: Record<string, string> = {
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2": "gemini-3.1-flash-image",
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2500, 7000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Copy of a provider response with the base64 image bytes removed, for logs.
function stripped(data: any) {
  return JSON.stringify(data, (k, v) =>
    typeof v === "string" && v.length > 200 ? `<${v.length} chars>` : v
  ).slice(0, 2000);
}

type ProviderResult =
  | { image: string; mimeType: string }
  | { error: string; status?: number; retryable: boolean };

// Gemini finish reasons that mean "content policy" — retrying won't help.
const GEMINI_BLOCK_REASONS: Record<string, string> = {
  SAFETY: "safety filter",
  IMAGE_SAFETY: "image safety filter",
  PROHIBITED_CONTENT: "prohibited content",
  IMAGE_PROHIBITED_CONTENT: "prohibited content",
  SPII: "sensitive personal information",
  BLOCKLIST: "blocked terms",
  RECITATION: "recitation check",
  IMAGE_RECITATION: "recitation check",
};

const PEOPLE_HINT =
  "Gemini often declines images of real people, especially children. Try GPT Image 2, different reference photos, or a rephrased prompt.";

function inspectGeminiResponse(data: any): ProviderResult {
  const block = data?.promptFeedback?.blockReason;
  if (block) {
    return {
      error: `Gemini blocked the prompt (${block}). ${PEOPLE_HINT}`,
      status: 422,
      retryable: false,
    };
  }
  const cand = data?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (imagePart) {
    return {
      image: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
    };
  }
  // Gemini explains refusals in finishMessage when the candidate has no parts
  const text: string | undefined = (
    parts.find((p) => typeof p.text === "string" && !p.thought)?.text ??
    (typeof cand?.finishMessage === "string" ? cand.finishMessage : undefined)
  )
    ?.trim()
    .slice(0, 400);
  const reason: string | undefined = cand?.finishReason;
  if (reason && GEMINI_BLOCK_REASONS[reason]) {
    return {
      error: `Gemini refused this image (${GEMINI_BLOCK_REASONS[reason]}${
        text ? `: ${text}` : ""
      }). ${PEOPLE_HINT}`,
      status: 422,
      retryable: false,
    };
  }
  if (text) {
    // The model answered in prose instead of drawing — usually a polite refusal.
    return { error: `The model replied with text instead of an image: ${text}`, status: 502, retryable: false };
  }
  // STOP / OTHER / IMAGE_OTHER / NO_IMAGE / missing: an intermittent empty
  // response — the same request typically succeeds on the next attempt.
  return {
    error: `The model returned no image (${reason ?? "no finish reason"}).`,
    status: 502,
    retryable: true,
  };
}

async function generateGemini(
  modelId: string,
  prompt: string,
  images: ImageInput[],
  resolution: string
): Promise<ProviderResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: "Server is missing GEMINI_API_KEY.", status: 500, retryable: false };

  const parts: object[] = images.map((img) => ({
    inline_data: { mime_type: img.mimeType, data: img.data },
  }));
  parts.push({ text: prompt });

  const body: Record<string, unknown> = { contents: [{ parts }] };
  if (resolution === "2K" || resolution === "4K") {
    body.generationConfig = { imageConfig: { imageSize: resolution } };
  }
  const payload = JSON.stringify(body);

  let last: ProviderResult = { error: "Generation failed.", retryable: true };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }
    );
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      last = {
        error: data?.error?.message || `Generation failed (HTTP ${res.status}).`,
        status: res.status,
        // overloaded / rate limited / transient server errors are worth another go
        retryable: res.status === 429 || res.status >= 500,
      };
    } else {
      last = inspectGeminiResponse(data);
    }

    if (!("error" in last)) return last;
    console.warn(
      `gemini ${modelId} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${last.error} | response: ${stripped(data)}`
    );
    if (!last.retryable || attempt === MAX_ATTEMPTS) break;
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5000);
  }
  if ("error" in last && last.retryable) {
    last = { ...last, error: `${last.error} Tried ${MAX_ATTEMPTS} times — please retry.` };
  }
  return last;
}

// gpt-image-2 takes explicit WIDTHxHEIGHT (longest edge ≤ 3840, ~8.3MP budget),
// so 2K/4K map to the standard 16:9 QHD / UHD sizes.
const OPENAI_SIZES: Record<string, string> = {
  "2K": "2560x1440",
  "4K": "3840x2160",
};

async function generateOpenAI(
  prompt: string,
  images: ImageInput[],
  resolution: string
): Promise<ProviderResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: "Server is missing OPENAI_API_KEY.", status: 500, retryable: false };

  const size = OPENAI_SIZES[resolution] ?? "auto";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await requestOpenAI(apiKey, prompt, images, size);
    const data = await res.json().catch(() => null);
    if (res.ok) {
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) return { image: b64, mimeType: "image/jpeg" };
      return { error: "The model returned no image.", status: 502, retryable: false };
    }
    const retryable = res.status === 429 || res.status >= 500;
    const error = data?.error?.message || `Generation failed (HTTP ${res.status}).`;
    console.warn(`openai attempt ${attempt}/${MAX_ATTEMPTS} failed: HTTP ${res.status} ${error}`);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      return { error, status: res.status, retryable };
    }
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5000);
  }
  return { error: "Generation failed.", status: 502, retryable: true };
}

async function requestOpenAI(
  apiKey: string,
  prompt: string,
  images: ImageInput[],
  size: string
): Promise<Response> {
  let res: Response;
  if (images.length === 0) {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // JPEG output keeps the response under Vercel's 4.5 MB limit (PNGs can exceed it)
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt,
        size,
        output_format: "jpeg",
        output_compression: 90,
      }),
    });
  } else {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", prompt);
    form.append("size", size);
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
  return res;
}

type Job = {
  id: string;
  prompt: string;
  model: string;
  images: ImageInput[];
  resolution: string;
};

async function markFailed(id: string, message: string) {
  try {
    await db.query(
      `UPDATE "NanoBananaHistory" SET "status" = 'failed', "error" = $2 WHERE "id" = $1`,
      [id, message.slice(0, 1000)]
    );
  } catch (dbErr) {
    console.error(`job ${id}: could not mark failed:`, dbErr);
  }
}

// Runs after the HTTP response has been sent. Several of these can be in
// flight at once — each one owns exactly one history row and only ever
// touches that row, so parallel jobs never interfere with each other.
async function runGeneration(job: Job) {
  const { id, prompt, model, images, resolution } = job;
  try {
    const result =
      model === "gpt-image-2"
        ? await generateOpenAI(prompt, images, resolution)
        : await generateGemini(GEMINI_MODELS[model], prompt, images, resolution);

    if ("error" in result) {
      await markFailed(id, result.error);
      return;
    }

    const bytes = Buffer.from(result.image, "base64");
    const [key, thumbKey] = await Promise.all([
      uploadResultImage(bytes, result.mimeType),
      // A missing thumbnail must never fail the job — the grid falls back to
      // the full image for that one card.
      makeThumbnail(bytes)
        .then(uploadThumbImage)
        .catch((e) => {
          console.error(`job ${id}: thumbnail failed:`, e);
          return null;
        }),
    ]);
    const { rowCount } = await db.query(
      `UPDATE "NanoBananaHistory"
          SET "status" = 'done', "imageKey" = $2, "mimeType" = $3, "thumbKey" = $4, "error" = NULL
        WHERE "id" = $1`,
      [id, key, result.mimeType, thumbKey]
    );
    if (rowCount === 0) {
      // The user deleted the pending entry while it was generating — don't
      // leave orphaned objects in S3.
      console.log(`job ${id}: row was deleted mid-generation, removing result objects`);
      for (const k of [key, thumbKey]) {
        if (k) await deleteImage(k).catch((e) => console.error("s3 cleanup failed:", e));
      }
    }
  } catch (err: any) {
    console.error(`job ${id} failed:`, err);
    await markFailed(id, err?.message || "Unexpected server error.");
  }
}

// Accepts the request, records a pending history row, and returns at once.
// The model call itself runs in the background (after()), so it keeps going
// if the browser reloads, and the client can start more jobs in parallel.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

// Re-run a failed job in place, using the input images already stored in S3.
async function retryJob(retryId: string) {
  const { rows } = await db.query(
    `UPDATE "NanoBananaHistory"
        SET "status" = 'pending', "error" = NULL, "startedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'failed'
      RETURNING "id", "prompt", "model", "resolution", "inputImageKeys", "inputImageCount", "createdAt"`,
    [retryId]
  );
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: "Only failed generations can be retried." }, { status: 409 });
  }
  const keys: string[] = row.inputImageKeys ?? [];
  let images: ImageInput[];
  try {
    images = await Promise.all(
      keys.map(async (key) => ({
        data: (await getObjectBuffer(key)).toString("base64"),
        mimeType: MIME_BY_EXT[key.split(".").pop() ?? ""] ?? "image/jpeg",
      }))
    );
  } catch (err: any) {
    await markFailed(row.id, `Could not load the stored input images: ${err?.message}`);
    return NextResponse.json({ error: "Could not load the stored input images." }, { status: 500 });
  }
  const resolution =
    row.resolution === "2K" || row.resolution === "4K" ? row.resolution : "1K";
  after(() =>
    runGeneration({ id: row.id, prompt: row.prompt, model: row.model, images, resolution })
  );
  return NextResponse.json(
    {
      item: {
        id: row.id,
        prompt: row.prompt,
        model: row.model,
        mimeType: "image/jpeg",
        inputImageCount: row.inputImageCount,
        resolution,
        createdAt: row.createdAt,
        status: "pending",
        error: null,
        url: null,
        thumbUrl: null,
        inputUrls: [],
      },
    },
    { status: 202 }
  );
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, model, images, resolution, retryId } = await req.json();

    if (retryId && typeof retryId === "string") return retryJob(retryId);

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "A prompt is required." }, { status: 400 });
    }
    if (model === "gpt-image-2") {
      if (!process.env.OPENAI_API_KEY)
        return NextResponse.json({ error: "Server is missing OPENAI_API_KEY." }, { status: 500 });
    } else if (GEMINI_MODELS[model]) {
      if (!process.env.GEMINI_API_KEY)
        return NextResponse.json({ error: "Server is missing GEMINI_API_KEY." }, { status: 500 });
    } else {
      return NextResponse.json({ error: "Unknown model." }, { status: 400 });
    }

    const imageList: ImageInput[] = Array.isArray(images)
      ? images.filter((img: any) => img?.data && img?.mimeType)
      : [];
    const effectiveResolution =
      resolution === "2K" || resolution === "4K" ? resolution : "1K";

    // Inputs are stored up front so the pending row is complete from the
    // start (Reuse / Delete work even if the job later fails).
    const inputKeys = await Promise.all(
      imageList.map((img) => uploadInputImage(Buffer.from(img.data, "base64"), img.mimeType))
    );

    const { rows } = await db.query(
      `INSERT INTO "NanoBananaHistory"
         ("prompt", "model", "inputImageCount", "inputImageKeys", "resolution", "status", "startedAt")
       VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
       RETURNING "id", "createdAt"`,
      [prompt, model, imageList.length, inputKeys, effectiveResolution]
    );
    const id: string = rows[0].id;

    after(() => runGeneration({ id, prompt, model, images: imageList, resolution: effectiveResolution }));

    // Same shape as an item from GET /api/history so the client can insert
    // it optimistically.
    return NextResponse.json(
      {
        item: {
          id,
          prompt,
          model,
          mimeType: "image/jpeg",
          inputImageCount: imageList.length,
          resolution: effectiveResolution,
          createdAt: rows[0].createdAt,
          status: "pending",
          error: null,
          url: null,
          thumbUrl: null,
          inputUrls: [],
        },
      },
      { status: 202 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unexpected server error." }, { status: 500 });
  }
}
