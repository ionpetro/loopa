/**
 * Optional Postgres (Supabase) persistence for per-user chat history and
 * job/run metadata.
 *
 * The in-memory maps stay the source of truth for live work; this is a
 * write-through so history survives process restarts. When DATABASE_URL is
 * unset everything no-ops — local-first behavior is unchanged. Persistence
 * failures are logged, never thrown: a DB outage must not break a recording.
 */
import pg from "pg";
import { log } from "./log.ts";
import type { ChatPart, DemoJob } from "./types.ts";

export interface RunRecord {
  id: string;
  goal: string;
  startUrl: string;
  status: string;
  userId?: string;
  /** OAuth client that created the run over MCP (abuse tracing/analytics). */
  clientId?: string;
  jobId?: string;
  liveViewUrl?: string;
  durationSec?: number;
  error?: string;
  actions: unknown[];
  createdAt: number;
}

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function dbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    // Supabase's pooler certs are signed by their own CA.
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

function ensureSchema(): Promise<void> {
  // Memoize success, but clear the memo on failure so a transient blip at boot
  // (DB unreachable for a moment) doesn't cache a rejected promise forever and
  // permanently disable every subsequent write until a restart.
  schemaReady ??= (async () => {
    await getPool().query(`
      create table if not exists demo_sessions (
        id text primary key,
        user_id text,
        created_at timestamptz not null default now()
      );
      create table if not exists demo_messages (
        id bigint generated always as identity primary key,
        session_id text not null references demo_sessions(id) on delete cascade,
        role text not null,
        parts jsonb not null default '[]',
        created_at timestamptz not null default now()
      );
      create table if not exists demo_jobs (
        id text primary key,
        user_id text,
        session_id text,
        goal text not null,
        start_url text not null,
        status text not null,
        actions jsonb not null default '[]',
        video_url text,
        duration_sec double precision,
        error text,
        created_at timestamptz not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists demo_runs (
        id text primary key,
        user_id text,
        goal text not null,
        start_url text not null,
        status text not null,
        job_id text,
        live_view_url text,
        duration_sec double precision,
        error text,
        actions jsonb not null default '[]',
        created_at timestamptz not null,
        updated_at timestamptz not null default now()
      );
      alter table demo_jobs add column if not exists title text;
      alter table demo_jobs add column if not exists thumb_url text;
      alter table demo_jobs add column if not exists recipe jsonb;
      alter table demo_jobs add column if not exists usage jsonb;
      alter table demo_jobs add column if not exists chapters jsonb;
      alter table demo_runs add column if not exists client_id text;
      create index if not exists demo_messages_session_idx on demo_messages (session_id, id);
      create index if not exists demo_sessions_user_idx on demo_sessions (user_id, created_at desc);
      create index if not exists demo_jobs_user_idx on demo_jobs (user_id, created_at desc);
      -- Tables live in the public schema, which Supabase exposes over PostgREST;
      -- RLS with no policies hides them from anon/authenticated API keys. Our
      -- direct connection is the table owner and bypasses RLS.
      alter table demo_sessions enable row level security;
      alter table demo_messages enable row level security;
      alter table demo_jobs enable row level security;
      alter table demo_runs enable row level security;
    `);
  })().catch((err) => {
    schemaReady = null; // allow the next write to retry the schema check
    throw err;
  });
  return schemaReady;
}

function logDbError(op: string, err: unknown) {
  log.error("db", `${op} failed`, err instanceof Error ? err.message : err);
}

/**
 * Fire-and-forget wrapper: ensure schema, run op, log-and-swallow failures.
 * Writes are chained so they hit the DB in call order — concurrent inserts on
 * separate pool connections raced (persistMessage landing before its
 * persistSession → FK violation, seen in prod).
 */
let writeChain: Promise<unknown> = Promise.resolve();
function tryDb(op: string, fn: () => Promise<unknown>): void {
  if (!dbEnabled()) return;
  writeChain = writeChain
    .then(() => ensureSchema())
    .then(fn)
    .catch((err) => logDbError(op, err));
}

/** Await all queued write-through operations (used before shutdown). */
export function flushDb(): Promise<void> {
  return writeChain.then(() => undefined);
}

export function persistSession(sessionId: string, userId: string | undefined): void {
  tryDb(`persistSession(${sessionId})`, () =>
    getPool().query(
      `insert into demo_sessions (id, user_id) values ($1, $2)
       on conflict (id) do update set user_id = coalesce(demo_sessions.user_id, excluded.user_id)`,
      [sessionId, userId ?? null],
    ),
  );
}

export function persistMessage(sessionId: string, role: "user" | "assistant", parts: ChatPart[]): void {
  tryDb(`persistMessage(${sessionId})`, () =>
    getPool().query(`insert into demo_messages (session_id, role, parts) values ($1, $2, $3::jsonb)`, [
      sessionId,
      role,
      JSON.stringify(parts),
    ]),
  );
}

/** Fire-and-forget upsert of a job's current state. */
export function persistJob(job: DemoJob): void {
  tryDb(`persistJob(${job.id})`, () =>
    getPool().query(
      `insert into demo_jobs (id, user_id, session_id, goal, title, start_url, status, actions, video_url, thumb_url, recipe, usage, chapters, duration_sec, error, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, to_timestamp($16 / 1000.0), now())
       on conflict (id) do update set
         status = excluded.status, title = coalesce(excluded.title, demo_jobs.title), actions = excluded.actions,
         video_url = excluded.video_url, thumb_url = coalesce(excluded.thumb_url, demo_jobs.thumb_url),
         recipe = coalesce(excluded.recipe, demo_jobs.recipe), usage = coalesce(excluded.usage, demo_jobs.usage),
         chapters = coalesce(excluded.chapters, demo_jobs.chapters),
         duration_sec = excluded.duration_sec, error = excluded.error, updated_at = now()`,
      [job.id, job.userId ?? null, job.sessionId ?? null, job.goal, job.title ?? null, job.startUrl, job.status,
       JSON.stringify(job.actions), job.videoUrl ?? null, job.thumbUrl ?? null,
       job.recipe ? JSON.stringify(job.recipe) : null, job.usage ? JSON.stringify(job.usage) : null,
       job.chapters ? JSON.stringify(job.chapters) : null,
       job.durationSec ?? null, job.error ?? null, job.createdAt],
    ),
  );
}

export interface JobRecord {
  id: string;
  title: string | null;
  goal: string;
  status: string;
  userId: string | null;
  videoUrl: string | null;
  thumbUrl: string | null;
  durationSec: number | null;
  createdAt: number;
  chapters: { title: string; start: number }[] | null;
}

function rowToJobRecord(r: any): JobRecord {
  return {
    id: r.id,
    title: r.title ?? null,
    goal: r.goal,
    status: r.status,
    userId: r.user_id ?? null,
    videoUrl: r.video_url ?? null,
    thumbUrl: r.thumb_url ?? null,
    durationSec: r.duration_sec ?? null,
    createdAt: new Date(r.created_at).getTime(),
    chapters: r.chapters ?? null,
  };
}

/** A user's finished videos, newest first. */
export async function listUserJobs(userId: string): Promise<JobRecord[]> {
  if (!dbEnabled()) return [];
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `select id, title, goal, status, user_id, video_url, thumb_url, duration_sec, created_at, chapters
       from demo_jobs where user_id = $1 and status = 'done' and video_url is not null
       order by created_at desc limit 100`,
      [userId],
    );
    return rows.map(rowToJobRecord);
  } catch (err) {
    logDbError(`listUserJobs(${userId})`, err);
    return [];
  }
}

/** One job by id (for the public watch page). */
export async function loadJobRecord(id: string): Promise<JobRecord | undefined> {
  if (!dbEnabled()) return undefined;
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `select id, title, goal, status, user_id, video_url, thumb_url, duration_sec, created_at, chapters from demo_jobs where id = $1`,
      [id],
    );
    return rows[0] ? rowToJobRecord(rows[0]) : undefined;
  } catch (err) {
    logDbError(`loadJobRecord(${id})`, err);
    return undefined;
  }
}

/** Fire-and-forget upsert of a run's current state. */
export function persistRun(run: RunRecord): void {
  tryDb(`persistRun(${run.id})`, () =>
    getPool().query(
      `insert into demo_runs (id, user_id, client_id, goal, start_url, status, job_id, live_view_url, duration_sec, error, actions, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, to_timestamp($12 / 1000.0), now())
       on conflict (id) do update set
         status = excluded.status, job_id = excluded.job_id, live_view_url = excluded.live_view_url,
         duration_sec = excluded.duration_sec, error = excluded.error, actions = excluded.actions, updated_at = now()`,
      [run.id, run.userId ?? null, run.clientId ?? null, run.goal, run.startUrl, run.status, run.jobId ?? null,
       run.liveViewUrl ?? null, run.durationSec ?? null, run.error ?? null, JSON.stringify(run.actions), run.createdAt],
    ),
  );
}

/**
 * How many videos a user started in the last `hours` — greatest of runs and
 * jobs, since an MCP run and its job describe the same work but interactive
 * jobs have no run. Returns null when the DB is unavailable (callers decide
 * whether to fail open).
 */
export async function countUserWorkSince(userId: string, hours: number): Promise<number | null> {
  if (!dbEnabled()) return null;
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `select greatest(
         (select count(*) from demo_jobs where user_id = $1 and created_at > now() - make_interval(hours => $2)),
         (select count(*) from demo_runs where user_id = $1 and created_at > now() - make_interval(hours => $2))
       )::int as n`,
      [userId, hours],
    );
    return rows[0].n;
  } catch (err) {
    logDbError(`countUserWorkSince(${userId})`, err);
    return null;
  }
}

/**
 * Mark rows left non-terminal by a previous process as errored. Called once
 * at boot, before this process accepts work: after a hard crash (OOM,
 * SIGKILL) the graceful-shutdown path never ran, and these rows would sit in
 * "recording"/"composing" forever while pollers see 202.
 */
export async function failStaleWork(reason: string): Promise<{ jobs: number; runs: number } | null> {
  if (!dbEnabled()) return null;
  try {
    await ensureSchema();
    const j = await getPool().query(
      `update demo_jobs set status = 'error', error = coalesce(error, $1), updated_at = now()
       where status not in ('done', 'error')`,
      [reason],
    );
    const r = await getPool().query(
      `update demo_runs set status = 'error', error = coalesce(error, $1), updated_at = now()
       where status not in ('done', 'error')`,
      [reason],
    );
    return { jobs: j.rowCount ?? 0, runs: r.rowCount ?? 0 };
  } catch (err) {
    logDbError("failStaleWork", err);
    return null;
  }
}

/** Load a run persisted by a previous process. Returns undefined on miss or error. */
export async function loadRunRecord(id: string): Promise<RunRecord | undefined> {
  if (!dbEnabled()) return undefined;
  try {
    await ensureSchema();
    const { rows } = await getPool().query(`select * from demo_runs where id = $1`, [id]);
    if (!rows[0]) return undefined;
    const r = rows[0];
    return {
      id: r.id,
      goal: r.goal,
      startUrl: r.start_url,
      status: r.status,
      userId: r.user_id ?? undefined,
      clientId: r.client_id ?? undefined,
      jobId: r.job_id ?? undefined,
      liveViewUrl: r.live_view_url ?? undefined,
      durationSec: r.duration_sec ?? undefined,
      error: r.error ?? undefined,
      actions: r.actions ?? [],
      createdAt: new Date(r.created_at).getTime(),
    };
  } catch (err) {
    logDbError(`loadRunRecord(${id})`, err);
    return undefined;
  }
}
