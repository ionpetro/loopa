# Code review — 2026-07-02

Full-codebase review (engine, backend/security, frontend, infra/docs), merged and
ranked. Checkboxes track fixes; a few items were already fixed during the review.

## Already fixed during review

- [x] Watchdog called `dispose()` instead of `abort()` — stalled runs left zombie
      `"recording"` job rows and disarmed the `handleMessage` fallback guard
      (`src/engine/headless-run.ts`)
- [x] `failAllActiveRuns()` on shutdown so planning-stage runs get a terminal
      error instead of 202-forever (`backend/server.ts`, `headless-run.ts`)
- [x] MCP tool description now warns the agent follows goals literally (logins,
      forms) and that videos are public (`backend/mcp.ts`)

## Critical — cost, data-loss, and abuse exposure

- [ ] **C1. Open `/mcp` = anonymous credit burning.** `MCP_AUTH_TOKEN` unset in
      prod; no rate limit; no concurrency cap; no `goal` length cap
      (`backend/server.ts` `mcpAuthorized`, `backend/mcp.ts` inputSchema,
      `src/engine/headless-run.ts` `startLoopaRun`). A loop against the public
      URL spawns N Kernel browsers + N Cursor runs.
      Fix bundle: `fly secrets set MCP_AUTH_TOKEN=…`; max ~2 concurrent runs in
      `startLoopaRun`; `goal: z.string().min(1).max(500)`.
- [ ] **C2. `readBody` buffers unbounded bodies** (`backend/server.ts`) —
      reachable unauthenticated on `/mcp`; OOMs the 1GB box. Cap ~1MB → 413.
- [ ] **C3. One transient failure permanently disables persistence/uploads.**
      `db.ts` `schemaReady ??=` and `storage.ts` `bucketReady ??=` cache a
      rejected promise forever. One DB blip at boot → every write fails until
      restart; one storage 5xx → every video silently falls to ephemeral disk.
      Reset the memoized promise on rejection.
- [ ] **C4. Disk exhaustion on the 1GB machine.**
      - `failJob()` never deletes `frames/` (up to ~300-400MB per failed job —
        tonight's stalls left these behind)
      - `raw.mp4` is a second identical copy nothing ever reads (`compose.ts`)
      - nothing prunes `data/jobs/*`
      Fix: rm frames in `failJob`; drop `raw.mp4`; startup sweep of old dirs.
- [ ] **C5. Weak IDs are the only access control; headless session IDs are
      derivable from public run IDs.** IDs are `Date.now().toString(36) +
      Math.random().slice(2,7)` (~26 bits + guessable timestamp) — videos, run
      status, and interactive Kernel live-view URLs are enumerable. A watch-link
      holder can compute `sess-run-…-a1` and POST into that run's agent session
      (`getOrCreateSession` accepts any client-supplied id).
      Fix: `crypto.randomUUID()` for job/run/session ids; make the session
      route reject ids it didn't issue (or mark headless sessions internal).

## High

- [ ] **H1. "Stable watchUrl" breaks after deploy even when the video survived.**
      `/api/runs/:id/video` redirects to `/api/jobs/:id/video` (local disk) and
      never consults the persisted Supabase `videoUrl` in `loopa_jobs`
      (`backend/server.ts`; fix via `loadJobRecord`). The GitHub commit-comment
      link dies on next deploy despite the MP4 living in Supabase.
- [ ] **H2. Public watch pages: black player for signed-out viewers** when
      serving from disk — `/api/jobs/(.*)` missing from the public matcher in
      `src/middleware.ts`.
- [ ] **H3. No Range-request support on video routes** (Next route + Fly
      server) — Safari/iOS refuse to play; seeking broken everywhere.
- [ ] **H4. MCP `get_loopa` uses in-memory `getLoopaRun`** while REST uses
      `loadLoopaRun` — after a deploy, MCP pollers get "no run with id …" for
      runs that exist in Postgres (`backend/mcp.ts`).
- [ ] **H5. Copy-agent-instructions emits `http://localhost:3001/mcp`** when
      `NEXT_PUBLIC_API_URL` is unset in the Vercel env (`src/app/page.tsx`
      `agentInstructions`). Verify the env var in prod; fix the fallback.
- [ ] **H6. Sessions/runs/jobs maps grow forever; headless sessions leak their
      `SDKAgent`** — `runAttempt` never disposes on success
      (`headless-run.ts`); no eviction anywhere (`agent-session.ts` `sessions`,
      `jobs.ts` `store`). Dispose at terminal state + evict old entries.

## Medium

- [ ] Typed chat messages silently erased when sent while busy — input cleared
      before `send()` early-returns; Enter bypasses the disabled button
      (`src/app/page.tsx` `submit`, `use-demo-session.ts`)
- [ ] `busy` sticks forever if the SSE stream closes without `agent_turn_done`
      (proxy cut / `maxDuration`) — add `finally` reset (`use-demo-session.ts`)
- [ ] SSE parser fragility (`use-demo-session.ts` `readSseEvents`): LF-only
      splitting (CRLF proxy → zero events + unbounded buffer); unguarded
      `JSON.parse` aborts the loop; reader never cancelled on early exit
- [ ] Recovery flow can stomp a newer take — `recoverJob` applies stale results
      unconditionally; check `liveJobRef.current === jobId`
- [ ] Intro/outro/brand overlays rendered but never composited — `composeVideo`
      reads only `overlays.caps`; the title card isn't in the MP4. Restore or
      delete (`compose.ts`, `browser-session.ts` `renderOverlays`)
- [ ] Frame writes fire-and-forget — ENOSPC frames still listed in `concat.txt`
      → baffling ffmpeg failures; `stopRecording` doesn't await pending writes
      (`browser-session.ts`)
- [ ] Transient `observe()` throw kills the whole take ("execution context
      destroyed" mid-navigation) — wrap post-action observes in try/catch
      (`agent-session.ts`)
- [ ] DB pool has no timeouts (`connectionTimeoutMillis: 0`) — one black-holed
      connection wedges the entire serialized write chain and hangs `flushDb`
      at shutdown (`db.ts` `getPool`)
- [ ] First-turn failure loses the system prompt — `hasStarted` flips before
      the run outcome is known (`agent-session.ts` `handleMessage`)
- [ ] Clerk: `verifyToken` without `authorizedParties` (`backend/server.ts`);
      CORS trusts every `https://*.vercel.app` origin by default
- [ ] Client disconnect doesn't cancel the billable recording turn (both
      servers — no `req.on("close")` / `req.signal` abort wiring)
- [ ] Next-on-Vercel API routes are a live broken fallback (no ffmpeg on
      Vercel; `maxDuration=300` kills long turns with no shutdown handling) —
      guard or remove from the Vercel build

## Low / housekeeping

- [ ] README: smoke-test command passes a goal argument `scripts/smoke.ts`
      ignores (argv[2] is the URL); "whole pipeline in-process, no extra infra"
      predates the Vercel/Fly split; stack section omits Clerk/Supabase/Postgres
- [ ] `recipe.json` is write-only — no replay entry point exists; README's
      "re-render without calling the model" is currently unfulfillable
- [ ] Railway references are stale: `railway.toml` (delete or mark legacy),
      `backend/server.ts:1` header comment, `.env.example` comments
- [ ] `.env.example` missing 7 vars the code reads: `CLERK_SECRET_KEY`,
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `DATABASE_URL`, `SUPABASE_URL`,
      `SUPABASE_SECRET_KEY`, `MCP_AUTH_TOKEN`, `ALLOW_VERCEL_ORIGINS`
- [ ] `npx skills add ionpetro/loopa` offers 22 skills — 21 vendored
      Clerk skills in `skills/` pollute the pick-list; move them out of the
      published namespace
- [ ] Docker: full frontend dep tree installed into the backend image; use
      `npm ci`; add `"type": "module"` to package.json (kills the reparse
      warning on every boot); pin the node:22 minor
- [ ] `ssl: { rejectUnauthorized: false }` — pin Supabase's pooler CA instead
      (`db.ts`)
- [ ] `MAX_FRAMES` backstop silently truncates the video (stops acking CDP
      frames) with no log; captions past the cutoff pile onto the last second
      (`browser-session.ts`)
- [ ] Failed actions still enter recipes and captions (`agent-session.ts`
      `browser_action`) — replays re-execute known-failed steps
- [ ] Unmuted `autoPlay` never plays (`page.tsx`, `videos/[id]/page.tsx`) —
      add `muted` or drop it; error banner could use `role="alert"`
- [ ] 12.5Hz clock re-renders the whole page during recording; `clock` not
      reset on a new take (`page.tsx`)
- [ ] Overlay fonts load from Google Fonts CDN; failure silently degrades to
      Arial (`browser-session.ts` `renderOverlays`)
- [ ] Stale `.vercelignore` entry (`db-probe.tmp.mjs`); `.gitignore` should be
      `.env*` + `!.env.example`; no `lint`/`typecheck` npm scripts
- [ ] Raw agent-run JSON dumped to logs on failure can include prompt/user
      content (`agent-session.ts` error logging)

## Verified clean

- No ffmpeg/caption injection: args via `execFile` (no shell), captions are
  PNGs not drawtext, concat entries escape quotes, overlay HTML escapes text
- No XSS: titles/goals/captions rendered as JSX text; agent text through
  Streamdown
- Clerk tokens correctly attached on chat send and `/api/me/videos`
- No secrets in git history (pattern scan clean); `.env` never committed
- Dockerfile copies everything the backend imports (incl. `mcp.ts`, engine
  assets); no unused or missing npm dependencies
- fly.toml internally consistent; `kill_timeout 30s` > the 20s shutdown deadline

## Suggested attack order

1. The Critical five (auth token + caps, memo-reset, disk hygiene, UUID ids) —
   one focused session
2. H1–H4 — make shared links actually reliable (the product promise)
3. Mediums opportunistically alongside feature work
