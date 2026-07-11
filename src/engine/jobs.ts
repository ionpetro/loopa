import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { persistJob } from "./db.ts";
import { log } from "./log.ts";
import { writableDataDir } from "./paths.ts";
import type { LoopaJob } from "./types.ts";

export const DATA_DIR = writableDataDir();

export function jobDir(jobId: string): string {
  return path.join(DATA_DIR, "jobs", jobId);
}

/**
 * Delete on-disk job directories older than `maxAgeMs` (default 24h). The
 * recording box only has ~1GB; without this, finished/failed job dirs
 * (final.mp4 + leftover frames) accumulate until the disk fills. Durable
 * copies live in Supabase Storage, so pruning local dirs is safe. Best-effort
 * and synchronous — cheap enough to run once at startup.
 */
export function sweepOldJobDirs(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const root = path.join(DATA_DIR, "jobs");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // no jobs dir yet
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  if (removed) log.info("jobs", `swept ${removed} job dir(s) older than ${Math.round(maxAgeMs / 3600000)}h`);
}

// Pinned to globalThis so Next.js dev-mode HMR doesn't wipe live jobs.
const store: Map<string, LoopaJob> = ((globalThis as any).__loopaJobs ??= new Map());

export function createJob(
  goal: string,
  startUrl: string,
  owner: { userId?: string; sessionId?: string } = {},
): LoopaJob {
  // Unguessable id: watch/status URLs are the only access control on a job.
  const id = `job-${randomUUID()}`;
  const job: LoopaJob = {
    id, goal, startUrl, status: "recording",
    userId: owner.userId, sessionId: owner.sessionId,
    actions: [], createdAt: Date.now(),
  };
  store.set(id, job);
  persistJob(job);
  return job;
}

export function getJob(id: string): LoopaJob | undefined {
  return store.get(id);
}

/** In-flight jobs owned by a user (quota enforcement). */
export function activeJobCountFor(userId: string): number {
  let n = 0;
  for (const j of store.values()) {
    if (j.userId === userId && j.status !== "done" && j.status !== "error") n++;
  }
  return n;
}
