"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ModelKey = "nano-banana-pro" | "nano-banana-2" | "gpt-image-2";

type JobStatus = "pending" | "done" | "failed";

type HistoryItem = {
  id: string;
  prompt: string;
  model: string;
  mimeType: string;
  inputImageCount: number;
  resolution: string | null;
  createdAt: string;
  status: JobStatus;
  error: string | null;
  url: string | null; // null until the job is done
  thumbUrl: string | null; // small JPEG for the grid (falls back to url)
  inputUrls: string[];
};

type UploadedImage = {
  id: string;
  data: string; // base64 without prefix
  mimeType: string;
  previewUrl: string;
  name: string;
};

const MAX_IMAGES = 6;
// ids of jobs started from this browser — persisted so a reload still shows
// the finished image in the Result panel
const MY_IDS_KEY = "nb:myIds";
const POLL_MS = 3000;
// Presigned S3 URLs are valid for 1h. Every history fetch mints fresh ones,
// which would change every <img src> and make the browser re-download all
// the images on each poll — so URLs younger than this are kept as-is.
const URL_REUSE_MS = 40 * 60 * 1000;
const PAGE_SIZE = 30;
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

// Image with a shimmer placeholder while the (presigned S3) URL loads
function LoadedImg({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className={`imgwrap ${loaded ? "loaded" : ""}`}>
      {!loaded && <span className="img-spinner" />}
      <img
        src={src}
        alt={alt}
        className={className}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </span>
  );
}

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
  const [resolution, setResolution] = useState<"1K" | "2K" | "4K">("1K");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [dragging, setDragging] = useState(false);
  // true only while the POST itself is in flight (~1s); generation continues
  // on the server and the button is free again for the next job
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [myIds, setMyIds] = useState<string[]>([]);
  const myIdsRef = useRef<string[]>([]);
  // "View all history": the first page is always loaded; older pages are
  // appended as the user scrolls (or presses Load more)
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const historyRef = useRef<HistoryItem[]>([]);
  const historyTopRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // monotonic counter so a slow /api/history response can't overwrite
  // newer local state (optimistic insert / delete)
  const historySeqRef = useRef(0);
  const prevStatusRef = useRef<Map<string, JobStatus>>(new Map());
  const urlIssuedAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MY_IDS_KEY);
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          myIdsRef.current = ids;
          setMyIds(ids);
        }
      }
    } catch {}
  }, []);

  const rememberIds = (update: (prev: string[]) => string[]) => {
    const next = update(myIdsRef.current).slice(0, 20);
    myIdsRef.current = next;
    setMyIds(next);
    try {
      localStorage.setItem(MY_IDS_KEY, JSON.stringify(next));
    } catch {}
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    // keep the page behind the modal from scrolling (matters on touch)
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [selected]);

  const loadHistory = useCallback(async () => {
    const seq = ++historySeqRef.current;
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load history.");
      if (seq !== historySeqRef.current) return; // superseded by a newer change
      const fresh: HistoryItem[] = data.items;
      const now = Date.now();
      setTotal(data.total ?? fresh.length);
      setHistory((prev) => {
        const prevById = new Map(prev.map((h) => [h.id, h]));
        const head = fresh.map((it) => {
          const old = prevById.get(it.id);
          const issued = urlIssuedAtRef.current.get(it.id) ?? 0;
          if (
            old &&
            old.status === it.status &&
            old.url &&
            now - issued < URL_REUSE_MS
          ) {
            // keep the image URLs stable so nothing re-downloads
            return { ...it, url: old.url, thumbUrl: old.thumbUrl, inputUrls: old.inputUrls };
          }
          urlIssuedAtRef.current.set(it.id, now);
          return it;
        });
        if (!expandedRef.current) {
          setHasMore(!!data.hasMore);
          return head;
        }
        // expanded: keep the older pages that were already scrolled in
        const headIds = new Set(head.map((h) => h.id));
        const lastHead = head[head.length - 1];
        const cut = lastHead ? prev.findIndex((h) => h.id === lastHead.id) : -1;
        const tail = (cut >= 0 ? prev.slice(cut + 1) : prev).filter(
          (h) => !headIds.has(h.id)
        );
        if (tail.length === 0) setHasMore(!!data.hasMore);
        return [...head, ...tail];
      });
      setHistoryError(null);
      // surface failures of jobs started from this browser
      for (const it of fresh) {
        if (
          myIdsRef.current.includes(it.id) &&
          prevStatusRef.current.get(it.id) === "pending" &&
          it.status === "failed"
        ) {
          setError(it.error || "Generation failed.");
        }
      }
      prevStatusRef.current = new Map(fresh.map((i) => [i.id, i.status]));
    } catch (err: any) {
      if (seq !== historySeqRef.current) return;
      setHistoryError(err.message || "Could not load history.");
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Poll while any job is still generating so cards flip to the finished
  // image (and the Result panel updates) without a manual refresh.
  const anyPending = history.some((h) => h.status === "pending");
  useEffect(() => {
    if (!anyPending) return;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        await loadHistory();
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [anyPending, loadHistory]);

  const deleteHistoryItem = async (id: string) => {
    historySeqRef.current++; // drop any in-flight poll that still has this row
    setHistory((prev) => prev.filter((h) => h.id !== id));
    rememberIds((prev) => prev.filter((x) => x !== id));
    if (selected?.id === id) setSelected(null);
    try {
      await fetch("/api/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } finally {
      loadHistory();
    }
  };

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Next page of older cards, after the last one currently loaded
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const last = historyRef.current[historyRef.current.length - 1];
    if (!last) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/history?cursor=${encodeURIComponent(last.id)}&limit=${PAGE_SIZE}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load more history.");
      const now = Date.now();
      const older: HistoryItem[] = data.items;
      setTotal(data.total ?? total);
      setHasMore(!!data.hasMore);
      setHistory((prev) => {
        const seen = new Set(prev.map((h) => h.id));
        const add = older.filter((h) => !seen.has(h.id));
        add.forEach((h) => urlIssuedAtRef.current.set(h.id, now));
        return [...prev, ...add];
      });
    } catch (err: any) {
      setHistoryError(err.message || "Could not load more history.");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [total]);

  const viewAll = () => {
    expandedRef.current = true;
    setExpanded(true);
    loadMore();
  };

  const showLess = () => {
    expandedRef.current = false;
    setExpanded(false);
    setHistory((prev) => prev.slice(0, PAGE_SIZE));
    setHasMore(total > PAGE_SIZE);
    historyTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Infinite scroll: fetch the next page when the sentinel below the grid
  // comes near the viewport.
  useEffect(() => {
    if (!expanded || !hasMore || loadingMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [expanded, hasMore, loadingMore, loadMore]);

  // Everything this browser started, newest first (history is already sorted)
  const mine = history.filter((h) => myIds.includes(h.id));
  const pendingMine = mine.filter((h) => h.status === "pending");
  const latestDone = mine.find((h) => h.status === "done") ?? null;

  const reuseHistoryItem = (item: HistoryItem) => {
    setPrompt(item.prompt);
    if (item.model in MODEL_INFO) setModel(item.model as ModelKey);
    if (item.resolution === "1K" || item.resolution === "2K" || item.resolution === "4K") {
      setResolution(item.resolution);
    }
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
    if (!prompt.trim() || submitting) return;
    const body = JSON.stringify({
      prompt: prompt.trim(),
      model,
      resolution,
      images: images.map(({ data, mimeType }) => ({ data, mimeType })),
    });
    if (body.length > MAX_PAYLOAD_BYTES) {
      setError(
        `Your images total ${(body.length / 1024 / 1024).toFixed(1)} MB — the upload limit is 4 MB. Please remove an image or two.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
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
          data?.error || `Could not start generation (HTTP ${res.status}).`,
        );
      }
      // The job is now running on the server. Show it in History right away
      // and let polling pick up the finished image.
      const item: HistoryItem = data.item;
      historySeqRef.current++;
      setHistory((prev) => [item, ...prev.filter((h) => h.id !== item.id)]);
      prevStatusRef.current.set(item.id, "pending");
      rememberIds((prev) => [item.id, ...prev.filter((x) => x !== item.id)]);
      loadHistory();
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  const useAsInput = async () => {
    if (!latestDone || images.length >= MAX_IMAGES) return;
    // Results live in S3 — fetch same-origin and run through the normal
    // compression pipeline so the next request stays under the limit.
    try {
      const res = await fetch(`/api/download?id=${latestDone.id}&inline=1`);
      if (!res.ok) throw new Error("Could not load the result image.");
      const blob = await res.blob();
      const file = new File([blob], "generated result", {
        type: latestDone.mimeType,
      });
      const { data, mimeType, previewUrl } = await compressImage(file);
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
                name: "generated result",
              },
            ],
      );
    } catch (err: any) {
      setError(err.message || "Could not reuse the result as input.");
    }
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
                  {images.length > 0 ? (
                    "Add more images"
                  ) : (
                    <>
                      <span className="dz-drop-hint">
                        Drop images here or click
                      </span>
                      <span className="dz-tap-hint">Tap</span> to browse
                    </>
                  )}
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

          <div className="panel-label" style={{ marginTop: 18 }}>
            Resolution
          </div>
          <div className="res-switch">
            {(["1K", "2K", "4K"] as const).map((r) => (
              <button
                key={r}
                className={resolution === r ? "active" : ""}
                title={`Generate at ${r}`}
                onClick={() => setResolution(r)}
              >
                {r}
              </button>
            ))}
          </div>

          <button
            className="generate"
            onClick={generate}
            disabled={submitting || !prompt.trim()}
          >
            {submitting ? "Starting…" : "✦ Generate"}
          </button>
          {pendingMine.length > 0 && (
            <p className="jobs-note">
              {pendingMine.length} generation{pendingMine.length > 1 ? "s" : ""}{" "}
              running in the background — you can start another one now.
            </p>
          )}

          {error && <div className="error">{error}</div>}

          <p className="model-note">
            Using <b>{MODEL_INFO[model].label}</b>
            <span className="kbd-hint"> · ⌘/Ctrl + Enter to generate</span>
          </p>
        </section>

        <section className="panel result-panel">
          <div className="panel-label">Result</div>
          <div className="result-body">
            {latestDone ? (
              <img src={latestDone.url ?? ""} alt="Generated result" />
            ) : pendingMine.length > 0 ? (
              <div className="loading">
                <div className="spinner" />
                <p>
                  {pendingMine.length === 1
                    ? `${MODEL_INFO[pendingMine[0].model as ModelKey]?.label ?? pendingMine[0].model} is painting your image…`
                    : `${pendingMine.length} generations in progress…`}
                </p>
              </div>
            ) : (
              <div className="placeholder">
                <div className="ph-icon">🍌</div>
                <p>
                  Upload one or more images, write a prompt, and your generated
                  image will appear here.
                </p>
              </div>
            )}
            {latestDone && pendingMine.length > 0 && (
              <div className="generating-badge">
                <span className="mini-spinner" />
                {pendingMine.length} generating…
              </div>
            )}
          </div>
          {latestDone && (
            <div className="result-actions">
              <a
                className="action-btn"
                href={`/api/download?id=${latestDone.id}`}
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

      <section className="panel history-panel" ref={historyTopRef}>
        <div className="history-head">
          <div className="panel-label">
            History
            {total > 0 && (
              <span className="history-count">
                {expanded ? `${history.length} of ${total}` : `${total} total`}
              </span>
            )}
          </div>
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
              <div
                className={`history-card ${
                  item.status !== "done" ? `is-${item.status}` : ""
                }`}
                key={item.id}
              >
                {item.status === "done" && item.url ? (
                  <a
                    href={item.url}
                    onClick={(e) => {
                      e.preventDefault();
                      setSelected(item);
                    }}
                  >
                    <LoadedImg src={item.thumbUrl ?? item.url} alt={item.prompt} />
                  </a>
                ) : item.status === "pending" ? (
                  <div className="history-thumb history-pending">
                    <div className="spinner" />
                    <span>Generating…</span>
                  </div>
                ) : (
                  <div className="history-thumb history-failed">
                    <div className="hf-icon">⚠️</div>
                    <span>{item.error || "Generation failed."}</span>
                  </div>
                )}
                <div className="history-info">
                  <p className="history-prompt" title={item.prompt}>
                    {item.prompt}
                  </p>
                  <div className="history-meta">
                    <span className="history-model">
                      {MODEL_INFO[item.model as ModelKey]?.label ?? item.model}
                    </span>
                    {item.resolution && (
                      <span className="history-res">{item.resolution}</span>
                    )}
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
                    {item.status !== "done" && (
                      <span className={`history-status ${item.status}`}>
                        {item.status === "pending" ? "generating" : "failed"}
                      </span>
                    )}
                  </div>
                  <div className="history-actions">
                    <button onClick={() => reuseHistoryItem(item)}>
                      ↩ Reuse
                    </button>
                    {item.status === "done" && (
                      <>
                        <button onClick={() => setSelected(item)}>
                          👁 View
                        </button>
                        <a
                          href={`/api/download?id=${item.id}`}
                          title="Download"
                        >
                          ⬇
                        </a>
                      </>
                    )}
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

        {history.length > 0 && (
          <div className="history-footer">
            {!expanded && hasMore && (
              <button className="history-more" onClick={viewAll}>
                View all history ({total} generations since day one)
              </button>
            )}
            {expanded && (
              <>
                <div ref={sentinelRef} className="history-sentinel" />
                {hasMore ? (
                  <button
                    className="history-more"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <>
                        <span className="mini-spinner" /> Loading older…
                      </>
                    ) : (
                      `Load more (${history.length} of ${total})`
                    )}
                  </button>
                ) : (
                  <p className="history-end">
                    That's everything — {history.length} generation
                    {history.length === 1 ? "" : "s"} since day one.
                  </p>
                )}
                <button className="history-less" onClick={showLess}>
                  Show less
                </button>
              </>
            )}
          </div>
        )}
      </section>

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelected(null)}>
              ✕
            </button>

            <div className="modal-meta">
              <span className="modal-model">
                {MODEL_INFO[selected.model as ModelKey]?.label ??
                  selected.model}
              </span>
              {selected.resolution && (
                <span className="modal-res">{selected.resolution}</span>
              )}
              <span className="modal-date">
                {new Date(selected.createdAt).toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <div className="modal-section-label">Prompt</div>
            <p className="modal-prompt">{selected.prompt}</p>

            {selected.inputUrls.length > 0 ? (
              <>
                <div className="modal-section-label">
                  Input images ({selected.inputUrls.length})
                </div>
                <div className="modal-inputs">
                  {selected.inputUrls.map((url, i) => (
                    <a href={url} target="_blank" rel="noreferrer" key={i}>
                      <LoadedImg src={url} alt={`Input ${i + 1}`} />
                    </a>
                  ))}
                </div>
              </>
            ) : (
              <div className="modal-section-label">
                Text-to-image — no input images
                {selected.inputImageCount > 0 &&
                  ` (${selected.inputImageCount} used, not stored for this older entry)`}
              </div>
            )}

            <div className="modal-section-label">Result</div>
            <a href={selected.url ?? "#"} target="_blank" rel="noreferrer">
              <LoadedImg
                className="modal-result"
                src={selected.url ?? ""}
                alt={selected.prompt}
              />
            </a>

            <div className="modal-actions">
              <a className="action-btn" href={`/api/download?id=${selected.id}`}>
                ⬇ Download result
              </a>
              <button
                className="action-btn"
                onClick={() => {
                  reuseHistoryItem(selected);
                  setSelected(null);
                }}
              >
                ↩ Reuse prompt & model
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
