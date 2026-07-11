/**
 * Headless loopa runs — the programmatic entry point used by the MCP server.
 *
 * A "run" wraps an AgentSession driven by a single autonomous prompt (no human
 * confirmation turn) and tracks its lifecycle so external agents can submit a
 * loopa and poll until the video is ready.
 */
import { randomUUID } from "node:crypto";
import { getOrCreateSession, type AgentSession } from "./agent-session.ts";
import { loadRunRecord, persistRun } from "./db.ts";
import { clip, log, since } from "./log.ts";
import { assertRunQuota } from "./quota.ts";
import type { ActionLog, SessionEvent } from "./types.ts";

export type RunStatus = "planning" | "awaiting_login" | "recording" | "composing" | "done" | "error";

export interface LoopaRun {
  id: string;
  goal: string;
  startUrl: string;
  status: RunStatus;
  /** Clerk user who requested the run (OAuth MCP callers); owns the job/video. */
  userId?: string;
  /** OAuth client the request came from (which agent/tool). */
  clientId?: string;
  jobId?: string;
  liveViewUrl?: string;
  durationSec?: number;
  error?: string;
  actions: ActionLog[];
  createdAt: number;
}

// Pinned to globalThis so Next.js dev-mode HMR doesn't wipe live runs.
const runs: Map<string, LoopaRun> = ((globalThis as any).__loopaRuns ??= new Map());

// Per-run secret backing the internal agent-session id. Kept out of LoopaRun so
// it never leaks through the run's JSON (watch pages, /api/runs, DB) — the
// runId itself is public via the watchUrl, so the session id must not be
// derivable from it. A holder of a watch link must not be able to POST into
// the run's live agent session.
const runSessionKeys: Map<string, string> = ((globalThis as any).__loopaRunSessionKeys ??= new Map());

// Live agent session per run, so confirmRunLogin can resolve a pending
// request_login without exposing the session id (see runSessionKeys above).
const runSessions: Map<string, AgentSession> = ((globalThis as any).__loopaRunSessions ??= new Map());

// Login-handoff live-view URL per run. Deliberately NOT a LoopaRun field: the
// run's JSON is public (watch pages, /api/runs, DB) keyed only on the runId,
// and this URL opens the browser the user is typing credentials into. It is
// served solely through getRunLoginState, which checks ownership.
const runLoginState: Map<string, { url: string; domain: string; hosted?: boolean }> = ((globalThis as any).__loopaRunLoginState ??= new Map());

const autonomousPrompt = (goal: string, startUrl: string) => `Autonomous run — there is no human in this chat. Never ask questions or wait for confirmation; the plan below is pre-approved.

Goal: ${goal}
Start URL: ${startUrl}

Do all of this in this single turn:
1. Call set_loop_params with the goal and start URL exactly as given.
2. Immediately call start_loop — do not ask for confirmation.
3. Record the loopa with browser_action calls: shortest clean path, short viewer-facing captions.
4. When the goal is visibly achieved, call finish_loop with a short title.

If an action fails, recover once and keep going; if the loopa cannot be completed, call finish_loop anyway so a partial video is produced.

Login walls: if the user has previously logged in to this site through Loopa, the browser opens already signed in. If a login wall still blocks the goal, call request_login — the person who requested this run is polling its status out-of-band and will sign in through a secure window themselves; the tool waits up to 10 minutes for them. If the wall only appears mid-recording, call abort_loop first, then request_login, then start_loop to re-record cleanly. NEVER type or guess credentials. If request_login times out or fails, do not record a login page: abort_loop any open recording with reason "login required", otherwise just end the turn — the run is failed automatically.`;

/**
 * One headless run at a time. Three concurrent runs on the shared-cpu-1x box
 * starved everything (26-minute recordings, encodes at ~2%/min, watchdog
 * "stalled" errors across the board — observed in prod overnight). Queued
 * runs sit in "planning" until a slot frees; pollers just see planning.
 */
const MAX_CONCURRENT_RUNS = 1;
let activeRuns = 0;
const runQueue: (() => void)[] = [];

function acquireRunSlot(): Promise<void> {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns++;
    return Promise.resolve();
  }
  return new Promise((resolve) => runQueue.push(resolve));
}

function releaseRunSlot(): void {
  const next = runQueue.shift();
  if (next) next();
  else activeRuns--;
}

export async function startLoopaRun(goal: string, startUrl: string, userId?: string, clientId?: string): Promise<LoopaRun> {
  await assertRunQuota(userId);
  const url = new URL(startUrl); // throws on invalid URL
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("startUrl must be an http(s) URL");
  }
  // Defensive cap at the shared entry point — not every caller passes through
  // the MCP tool's Zod schema, and an unbounded goal is fed straight to the
  // model as prompt text.
  goal = goal.trim();
  if (!goal) throw new Error("goal must not be empty");
  if (goal.length > 500) throw new Error("goal must be 500 characters or fewer");

  // Unguessable id: the public watchUrl and status endpoints are keyed only on
  // this, so an enumerable id would let anyone read/poll other people's runs.
  const id = `run-${randomUUID()}`;
  const run: LoopaRun = { id, goal, startUrl, userId, clientId, status: "planning", actions: [], createdAt: Date.now() };
  runs.set(id, run);
  persistRun(run);
  log.info(`run ${id}`, `created by ${userId ?? "anon"} — start ${startUrl}, goal "${clip(goal)}"`);
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    log.info(`run ${id}`, `queued behind ${runQueue.length + activeRuns} run(s) — stays "planning" until a slot frees`);
  }
  void (async () => {
    await acquireRunSlot();
    try {
      // May have been failed while queued (e.g. shutdown's failAllActiveRuns).
      if ((run.status as RunStatus) !== "error") await executeRun(run);
    } finally {
      releaseRunSlot();
      // Run is terminal; the session secret is no longer needed.
      runSessionKeys.delete(run.id);
      runSessions.delete(run.id);
      runLoginState.delete(run.id);
    }
  })();
  return run;
}

async function executeRun(run: LoopaRun) {
  // The Cursor API occasionally kills a run instantly ("Agent ... not found",
  // sub-second failures observed in prod). Those die before any browser work,
  // so retrying once on a fresh session is cheap and safe. Never retry once
  // recording started — that would burn a whole take.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log.info(`run ${run.id}`, `attempt ${attempt}/${MAX_ATTEMPTS} starting`);
    await runAttempt(run, attempt);
    if (run.status === "done") {
      log.info(`run ${run.id}`, `done in ${since(run.createdAt)} — ${run.durationSec ?? "?"}s video (job ${run.jobId})`);
      return;
    }
    if (run.jobId || run.actions.length) break;
    // A login-required failure is the user's to resolve — retrying would just
    // hold the run slot through another 10-minute handoff wait.
    if (run.error?.startsWith("login required")) break;
    if (attempt < MAX_ATTEMPTS) {
      log.warn(`run ${run.id}`, `attempt ${attempt} failed before recording (${run.error ?? "no detail"}) — retrying`);
      run.status = "planning";
      run.error = undefined;
      persistRun(run);
    }
  }
  if ((run.status as RunStatus) !== "done") {
    run.status = "error";
    run.error ??= "run ended without producing a video";
  }
  log.error(`run ${run.id}`, `failed after ${since(run.createdAt)}: ${run.error}`);
  persistRun(run);
}

function runAttempt(run: LoopaRun, attempt: number): Promise<void> {
  // Fresh session per attempt. The id is derived from a per-run random secret,
  // not the (public) runId, so a watch-link holder can't compute it and POST
  // into the live agent session. The sess- prefix keeps it valid for the API.
  let key = runSessionKeys.get(run.id);
  if (!key) {
    key = randomUUID();
    runSessionKeys.set(run.id, key);
  }
  const session = getOrCreateSession(`sess-${key}-a${attempt}`);
  runSessions.set(run.id, session);
  // Attribute the session (and therefore the job/video) to the OAuth caller so
  // MCP-created videos land in their library like UI-created ones.
  session.setUser(run.userId);

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
    // A login handoff legitimately sits idle while the user signs in (up to
    // 10 min, enforced by request_login itself) — freeze the stall clock.
    if (run.status === "awaiting_login") {
      lastEventAt = Date.now();
      return;
    }
    if (Date.now() - lastEventAt > STALL_MS) {
      clearInterval(watchdog);
      run.status = "error";
      run.error = `run stalled — no agent activity for ${Math.round(STALL_MS / 60_000)} minutes`;
      log.error(`run ${run.id}`, `watchdog: ${run.error} — tearing the session down`);
      persistRun(run);
      // abort (not dispose): fails the open job so loopa_jobs doesn't keep a
      // zombie "recording" row — dispose alone also disarms handleMessage's
      // fallback failJob guard by nulling the browser first.
      void session.abort(run.error).catch(() => {});
    }
  }, 30_000);

  const unsubscribe = session.subscribe((ev: SessionEvent) => {
    lastEventAt = Date.now();
    if (ev.type === "job_created") {
      run.jobId = ev.jobId;
      run.status = "recording";
      // A re-record after an aborted take (login wall mid-recording) starts
      // clean — the aborted job's error must not outlive it.
      run.error = undefined;
      log.info(`run ${run.id}`, `recording as job ${ev.jobId}`);
    } else if (ev.type === "needs_login") {
      run.status = "awaiting_login";
      runLoginState.set(run.id, { url: ev.url, domain: ev.domain, hosted: ev.hosted });
      log.info(`run ${run.id}`, `paused for login to ${ev.domain} — waiting for confirm_login`);
    } else if (ev.type === "login_done") {
      runLoginState.delete(run.id);
      if (run.status === "awaiting_login") run.status = "planning";
      // Timed out: pre-recording there is no job to abort, so nothing else
      // would ever set a meaningful error (and the caller shouldn't retry).
      if (!ev.confirmed) run.error ??= "login required — the sign-in was not completed within 10 minutes";
    } else if (ev.type === "live_view") {
      run.liveViewUrl = ev.url;
    } else if (ev.type === "action") {
      run.actions.push({ n: ev.n, action: ev.action, caption: ev.caption, ok: ev.ok, error: ev.error });
    } else if (ev.type === "job_status") {
      if (ev.status === "composing") run.status = "composing";
      if (ev.status === "error" && run.status !== "done") {
        // Carry the job's failure reason but do NOT mark the run terminal yet:
        // the agent may abort a take at a login wall and continue with
        // request_login + a re-record in the same turn, and a poller that saw
        // a transient "error" would give up. executeRun settles the final
        // status once the turn actually ends without a video.
        run.error ??= ev.error;
      }
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

  return session
    .handleMessage(autonomousPrompt(run.goal, run.startUrl))
    .catch((err) => {
      run.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      clearInterval(watchdog);
      unsubscribe();
    });
}

export function getLoopaRun(id: string): LoopaRun | undefined {
  return runs.get(id);
}

/**
 * Login-handoff live view for a run paused in awaiting_login. Ownership-gated:
 * this URL opens the browser the user is signing in to, so unlike the rest of
 * the run snapshot it is only released to the caller the run belongs to.
 */
export function getRunLoginState(id: string, viewerUserId?: string): { url: string; domain: string; hosted?: boolean } | undefined {
  const run = runs.get(id);
  if (!run || run.userId !== viewerUserId) return undefined;
  return runLoginState.get(id);
}

/**
 * Resolve a run's pending request_login (the MCP confirm_login tool). The
 * session id stays server-side — callers only ever hold the runId.
 */
export function confirmRunLogin(id: string, viewerUserId?: string): { ok: true } | { ok: false; reason: string } {
  const run = runs.get(id);
  if (!run) return { ok: false, reason: `no live run with id ${id} — it may have finished or run on a previous server process` };
  if (run.userId !== viewerUserId) return { ok: false, reason: "this run belongs to a different user" };
  const session = runSessions.get(id);
  if (!session?.confirmLogin()) return { ok: false, reason: `no login is pending for this run (status: ${run.status})` };
  return { ok: true };
}

/** In-flight (incl. queued) runs owned by a user (quota enforcement). */
export function activeRunCountFor(userId: string): number {
  let n = 0;
  for (const r of runs.values()) {
    if (r.userId === userId && r.status !== "done" && r.status !== "error") n++;
  }
  return n;
}

/**
 * Mark every non-terminal run as errored (called on server shutdown).
 * Covers runs abort() can't reach — e.g. still in "planning" with no job yet —
 * so pollers get a definitive error instead of 202 forever.
 */
export function failAllActiveRuns(reason: string): void {
  for (const run of runs.values()) {
    if (run.status !== "done" && run.status !== "error") {
      run.status = "error";
      run.error ??= reason;
      persistRun(run);
    }
  }
}

/** Like getLoopaRun, but falls back to the DB for runs from a previous process. */
export async function loadLoopaRun(id: string): Promise<LoopaRun | undefined> {
  const live = runs.get(id);
  if (live) return live;
  const rec = await loadRunRecord(id);
  if (!rec) return undefined;
  return { ...rec, status: rec.status as RunStatus, actions: rec.actions as ActionLog[] };
}
