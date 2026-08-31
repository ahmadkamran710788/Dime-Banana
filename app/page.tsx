"use client";

import { useEffect, useRef, useState } from "react";

type ModelKey = "nano-banana-pro" | "nano-banana-2" | "gpt-image-2";

type HistoryItem = {
  id: string;
  prompt: string;
  model: string;
  mimeType: string;
  inputImageCount: number;
  createdAt: string;
  url: string;
};

type UploadedImage = {
  id: string;
  data: string; // base64 without prefix
  mimeType: string;
  previewUrl: string;
  name: string;
};

const MAX_IMAGES = 6;
//okok
const MODEL_INFO: Record<ModelKey, { label: string; blurb: string }> = {
  "nano-banana-pro": {
    label: "Nano Banana Pro",
    blurb: "Highest quality — best for detailed edits and complex scenes",
  },
  "nano-banana-2": {
    label: "Nano Banana 2",
    blurb: "Fast and efficient — great for quick generations",
  },
  "gpt-image-2": {
    label: "GPT Image 2",
    blurb: "OpenAI's image model — strong text rendering and precise edits",
  },
};

let nextId = 0;

// Vercel rejects request bodies over 4.5 MB, so images are downscaled
// in the browser before upload to keep the JSON payload safely under it.
const MAX_DIMENSION = 1536;
const JPEG_QUALITY = 0.85;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function compressImage(
  file: File,
): Promise<{ data: string; mimeType: string; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(
        1,
        MAX_DIMENSION / Math.max(img.width, img.height),
      );
      // Small files that need no resizing are sent as-is
      if (scale === 1 && file.size <= 700 * 1024) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          resolve({
            data: dataUrl.split(",")[1],
            mimeType: file.type,
            previewUrl: dataUrl,
          });
        };
        reader.onerror = () => reject(new Error("Could not read file."));
        reader.readAsDataURL(file);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx)
        return reject(new Error("Canvas is not supported in this browser."));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      resolve({
        data: dataUrl.split(",")[1],
        mimeType: "image/jpeg",
        previewUrl: dataUrl,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load image."));
    };
    img.src = url;
  });
}

export default function Home() {
  const [model, setModel] = useState<ModelKey>("nano-banana-pro");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ src: string; mime: string } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = async () => {
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load history.");
      setHistory(data.items);
      setHistoryError(null);
    } catch (err: any) {
      setHistoryError(err.message || "Could not load history.");
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const deleteHistoryItem = async (id: string) => {
    setHistory((prev) => prev.filter((h) => h.id !== id));
    await fetch("/api/history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => loadHistory());
  };

  const reuseHistoryItem = (item: HistoryItem) => {
    setPrompt(item.prompt);
    if (item.model in MODEL_INFO) setModel(item.model as ModelKey);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const loadFiles = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) {
      setError("Please choose image files.");
      return;
    }
    setError(null);
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    list.slice(0, room).forEach((file) => {
      compressImage(file)
        .then(({ data, mimeType, previewUrl }) => {
          setImages((prev) =>
            prev.length >= MAX_IMAGES
              ? prev
              : [
                  ...prev,
                  {
                    id: `img-${nextId++}`,
                    data,
                    mimeType,
                    previewUrl,
                    name: file.name,
                  },
                ],
          );
        })
        .catch((err) => setError(err.message || "Could not process image."));
    });
    if (list.length > room) {
      setError(
        `Only the first ${room} image(s) were added — max ${MAX_IMAGES} total.`,
      );
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  const generate = async () => {
    if (!prompt.trim() || loading) return;
    const body = JSON.stringify({
      prompt: prompt.trim(),
      model,
      images: images.map(({ data, mimeType }) => ({ data, mimeType })),
    });
    if (body.length > MAX_PAYLOAD_BYTES) {
      setError(
        `Your images total ${(body.length / 1024 / 1024).toFixed(1)} MB — the upload limit is 4 MB. Please remove an image or two.`,
      );
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // non-JSON error body (e.g. a 413 from the hosting platform)
      }
      if (!res.ok) {
        if (res.status === 413)
          throw new Error(
            "Upload too large — please remove an image or two and try again.",
          );
        if (res.status === 429)
          throw new Error(
            "Rate limit reached — please wait a moment and try again.",
          );
        throw new Error(
          data?.error || `Generation failed (HTTP ${res.status}).`,
        );
      }
      setResult({
        src: `data:${data.mimeType};base64,${data.image}`,
        mime: data.mimeType,
      });
      loadHistory();
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const useAsInput = () => {
    if (!result || images.length >= MAX_IMAGES) return;
    setImages((prev) => [
      ...prev,
      {
        id: `img-${nextId++}`,
        data: result.src.split(",")[1],
        mimeType: result.mime,
        previewUrl: result.src,
        name: "generated result",
      },
    ]);
  };

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <div className="brand-icon">🍌</div>
          <div>
            <h1>
              Nano Banana <span>Studio</span>
            </h1>
            <p>{MODEL_INFO[model].blurb}</p>
          </div>
        </div>
        <div className="model-switch">
          {(Object.keys(MODEL_INFO) as ModelKey[]).map((key) => (
            <button
              key={key}
              className={model === key ? "active" : ""}
              onClick={() => setModel(key)}
            >
              {MODEL_INFO[key].label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid">
        <section className="panel">
          <div className="panel-label">
            Reference images (optional · {images.length}/{MAX_IMAGES})
          </div>

          {images.length > 0 && (
            <div className="thumbs">
              {images.map((img) => (
                <div className="thumb" key={img.id} title={img.name}>
                  <img src={img.previewUrl} alt={img.name} />
                  <button
                    className="thumb-remove"
                    onClick={() => removeImage(img.id)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {images.length < MAX_IMAGES && (
            <div
              className={`dropzone ${dragging ? "dragging" : ""} ${
                images.length > 0 ? "compact" : ""
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.files?.length)
                  loadFiles(e.dataTransfer.files);
              }}
            >
              <div className="dz-inner">
                <div className="dz-icon">🖼️</div>
                <p>
                  {images.length > 0
                    ? "Add more images"
                    : "Drop images here or click to browse"}
                </p>
                <small>
                  PNG, JPG, WebP · select several at once · leave empty for
                  text-to-image
                </small>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  if (e.target.files?.length) loadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          )}

          <div className="panel-label">Prompt</div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              images.length > 1
                ? "Describe how to combine these images… e.g. “Put the subject of the first image into the scene of the second”"
                : images.length === 1
                  ? "Describe how to transform this image… e.g. “Turn this into a watercolor painting at sunset”"
                  : "Describe the image you want… e.g. “A cozy cabin in a snowy forest, golden hour, cinematic”"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
            }}
          />

          <button
            className="generate"
            onClick={generate}
            disabled={loading || !prompt.trim()}
          >
            {loading ? "Generating…" : "✦ Generate"}
          </button>

          {error && <div className="error">{error}</div>}

          <p className="model-note">
            Using <b>{MODEL_INFO[model].label}</b> · ⌘/Ctrl + Enter to generate
          </p>
        </section>

        <section className="panel result-panel">
          <div className="panel-label">Result</div>
          <div className="result-body">
            {loading ? (
              <div className="loading">
                <div className="spinner" />
                <p>{MODEL_INFO[model].label} is painting your image…</p>
              </div>
            ) : result ? (
              <img src={result.src} alt="Generated result" />
            ) : (
              <div className="placeholder">
                <div className="ph-icon">🍌</div>
                <p>
                  Upload one or more images, write a prompt, and your generated
                  image will appear here.
                </p>
              </div>
            )}
          </div>
          {result && !loading && (
            <div className="result-actions">
              <a
                className="action-btn"
                href={result.src}
                download={`nano-banana-${Date.now()}.png`}
              >
                ⬇ Download
              </a>
              <button
                className="action-btn"
                onClick={useAsInput}
                disabled={images.length >= MAX_IMAGES}
              >
                ↺ Use as input
              </button>
            </div>
          )}
        </section>
      </div>

      <section className="panel history-panel">
        <div className="history-head">
          <div className="panel-label">History</div>
          <button className="history-refresh" onClick={loadHistory} title="Refresh">
            ↻ Refresh
          </button>
        </div>
        {historyError ? (
          <div className="error">{historyError}</div>
        ) : history.length === 0 ? (
          <p className="history-empty">
            No generations yet — your prompts, models and results will appear
            here.
          </p>
        ) : (
          <div className="history-grid">
            {history.map((item) => (
              <div className="history-card" key={item.id}>
                <a href={item.url} target="_blank" rel="noreferrer">
                  <img src={item.url} alt={item.prompt} loading="lazy" />
                </a>
                <div className="history-info">
                  <p className="history-prompt" title={item.prompt}>
                    {item.prompt}
                  </p>
                  <div className="history-meta">
                    <span className="history-model">
                      {MODEL_INFO[item.model as ModelKey]?.label ?? item.model}
                    </span>
                    <span>
                      {item.inputImageCount > 0
                        ? `${item.inputImageCount} input img`
                        : "text-to-image"}
                    </span>
                    <span>
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="history-actions">
                    <button onClick={() => reuseHistoryItem(item)}>
                      ↩ Reuse
                    </button>
                    <a href={item.url} download target="_blank" rel="noreferrer">
                      ⬇ Open
                    </a>
                    <button
                      className="danger"
                      onClick={() => deleteHistoryItem(item.id)}
                    >
                      ✕ Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
