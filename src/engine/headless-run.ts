/**
 * Headless demo runs — the programmatic entry point used by the MCP server.
 *
 * A "run" wraps an AgentSession driven by a single autonomous prompt (no human
 * confirmation turn) and tracks its lifecycle so external agents can submit a
 * demo and poll until the video is ready.
 */
import { getOrCreateSession } from "./agent-session.ts";
import { loadRunRecord, persistRun } from "./db.ts";
import type { ActionLog, SessionEvent } from "./types.ts";

export type RunStatus = "planning" | "recording" | "composing" | "done" | "error";

export interface DemoRun {
  id: string;
  goal: string;
  startUrl: string;
  status: RunStatus;
  jobId?: string;
  liveViewUrl?: string;
  durationSec?: number;
  error?: string;
  actions: ActionLog[];
  createdAt: number;
}

// Pinned to globalThis so Next.js dev-mode HMR doesn't wipe live runs.
const runs: Map<string, DemoRun> = ((globalThis as any).__demoRuns ??= new Map());

const autonomousPrompt = (goal: string, startUrl: string) => `Autonomous run — there is no human in this chat. Never ask questions or wait for confirmation; the plan below is pre-approved.

Goal: ${goal}
Start URL: ${startUrl}

Do all of this in this single turn:
1. Call set_demo_params with the goal and start URL exactly as given.
2. Immediately call start_demo — do not ask for confirmation.
3. Record the demo with browser_action calls: shortest clean path, short viewer-facing captions.
4. When the goal is visibly achieved, call finish_demo with a short title.

If an action fails, recover once and keep going; if the demo cannot be completed, call finish_demo anyway so a partial video is produced.`;

export function startDemoRun(goal: string, startUrl: string): DemoRun {
  const url = new URL(startUrl); // throws on invalid URL
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("startUrl must be an http(s) URL");
  }

  const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  // One session per run; the sess- prefix keeps it valid for the session API.
  const session = getOrCreateSession(`sess-${id}`);
  const run: DemoRun = { id, goal, startUrl, status: "planning", actions: [], createdAt: Date.now() };
  runs.set(id, run);
  persistRun(run);

  // Watchdog: an agent stream can hang mid-run (observed in prod), leaving the
  // run stuck in "recording" with a live cloud browser leaking. If no event
  // arrives for STALL_MS, fail the run and tear the session down.
  const STALL_MS = 5 * 60_000;
  let lastEventAt = Date.now();
  const watchdog = setInterval(() => {
    if (run.status === "done" || run.status === "error") {
      clearInterval(watchdog);
      return;
    }
    if (Date.now() - lastEventAt > STALL_MS) {
      clearInterval(watchdog);
      run.status = "error";
      run.error = `run stalled — no agent activity for ${Math.round(STALL_MS / 60_000)} minutes`;
      persistRun(run);
      void session.dispose().catch(() => {});
    }
  }, 30_000);

  const unsubscribe = session.subscribe((ev: SessionEvent) => {
    lastEventAt = Date.now();
    if (ev.type === "job_created") {
      run.jobId = ev.jobId;
      run.status = "recording";
    } else if (ev.type === "live_view") {
      run.liveViewUrl = ev.url;
    } else if (ev.type === "action") {
      run.actions.push({ n: ev.n, action: ev.action, caption: ev.caption, ok: ev.ok, error: ev.error });
    } else if (ev.type === "job_status") {
      if (ev.status === "composing") run.status = "composing";
      if (ev.status === "error" && run.status !== "done") run.status = "error";
    } else if (ev.type === "video_ready") {
      run.status = "done";
      run.durationSec = ev.durationSec;
    } else if (ev.type === "error" && run.status !== "done") {
      run.error = ev.message;
    } else {
      return;
    }
    persistRun(run);
  });

  session
    .handleMessage(autonomousPrompt(goal, startUrl))
    .catch((err) => {
      run.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      clearInterval(watchdog);
      unsubscribe();
      if (run.status !== "done") {
        run.status = "error";
        run.error ??= "run ended without producing a video";
      }
      persistRun(run);
    });

  return run;
}

export function getDemoRun(id: string): DemoRun | undefined {
  return runs.get(id);
}

/** Like getDemoRun, but falls back to the DB for runs from a previous process. */
export async function loadDemoRun(id: string): Promise<DemoRun | undefined> {
  const live = runs.get(id);
  if (live) return live;
  const rec = await loadRunRecord(id);
  if (!rec) return undefined;
  return { ...rec, status: rec.status as RunStatus, actions: rec.actions as ActionLog[] };
}
