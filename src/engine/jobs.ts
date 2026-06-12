import path from "node:path";
import type { DemoJob } from "./types.ts";

export const DATA_DIR = path.join(process.cwd(), "data");

export function jobDir(jobId: string): string {
  return path.join(DATA_DIR, "jobs", jobId);
}

// Pinned to globalThis so Next.js dev-mode HMR doesn't wipe live jobs.
const store: Map<string, DemoJob> = ((globalThis as any).__demoJobs ??= new Map());

export function createJob(goal: string, startUrl: string): DemoJob {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const job: DemoJob = { id, goal, startUrl, status: "recording", actions: [], createdAt: Date.now() };
  store.set(id, job);
  return job;
}

export function getJob(id: string): DemoJob | undefined {
  return store.get(id);
}
