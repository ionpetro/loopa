/**
 * Optional Supabase Storage upload for finished videos. Gated on
 * SUPABASE_URL + SUPABASE_SECRET_KEY; when unset, videos stay on local disk
 * only (served by /api/jobs/:id/video). Uses the Storage REST API directly —
 * no SDK needed for a single upload call.
 */
import fs from "node:fs";
import { log } from "./log.ts";

const BUCKET = "videos";
let bucketReady: Promise<void> | null = null;

export function storageEnabled(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function headers(): Record<string, string> {
  const key = process.env.SUPABASE_SECRET_KEY!;
  return { Authorization: `Bearer ${key}`, apikey: key };
}

async function ensureBucket(): Promise<void> {
  // Memoize success, but clear the memo on failure so one transient storage
  // 5xx at boot doesn't cache a rejected promise forever — which would silently
  // route every finished video to ephemeral local disk until a restart.
  bucketReady ??= (async () => {
    const base = process.env.SUPABASE_URL!.replace(/\/$/, "");
    const res = await fetch(`${base}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    // 409 = already exists; anything else unexpected is a real failure.
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      if (!/already exists/i.test(body)) throw new Error(`bucket create failed (${res.status}): ${body.slice(0, 160)}`);
    }
  })().catch((err) => {
    bucketReady = null; // allow the next upload to retry bucket creation
    throw err;
  });
  return bucketReady;
}

/**
 * Upload a finished MP4 and return its public URL. Returns undefined only
 * when storage is not configured (local-first: callers serve from disk).
 * When storage IS configured, a failed upload THROWS after retries — the old
 * log-and-return-undefined behavior let the job be marked done with a link
 * that only worked until the recording box's disk sweep or next deploy.
 */
export async function uploadVideo(jobId: string, filePath: string): Promise<string | undefined> {
  if (!storageEnabled()) return undefined;
  try {
    return await uploadObject(`${jobId}.mp4`, filePath, "video/mp4");
  } catch (err) {
    throw new Error(`video upload to storage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Upload the poster frame next to the MP4. Best-effort at the call site — a
 * missing thumbnail must never fail a finished job.
 */
export async function uploadThumbnail(jobId: string, filePath: string): Promise<string | undefined> {
  if (!storageEnabled()) return undefined;
  return uploadObject(`${jobId}.jpg`, filePath, "image/jpeg");
}

async function uploadObject(objectPath: string, filePath: string, contentType: string): Promise<string> {
  const ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await ensureBucket();
      const base = process.env.SUPABASE_URL!.replace(/\/$/, "");
      const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": contentType, "x-upsert": "true" },
        body: fs.readFileSync(filePath),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`upload failed (${res.status}): ${body.slice(0, 160)}`);
      }
      return `${base}/storage/v1/object/public/${BUCKET}/${objectPath}`;
    } catch (err) {
      lastErr = err;
      log.warn(
        "storage",
        `upload(${objectPath}) attempt ${attempt}/${ATTEMPTS} failed: ${err instanceof Error ? err.message : err}`,
      );
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
