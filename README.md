# Loopa.sh

Chat with an agent about the browser demo you want, watch it drive a live cloud
browser, and download the finished MP4.

```
You ──chat──▶ Cursor SDK agent (composer-2.5)
                 │  plans the walkthrough with you
                 ▼
              Kernel cloud browser ◀── you watch via live-view iframe
                 │  agent drives it (playwright over CDP)
                 │  CDP screencast captures every frame
                 ▼
              ffmpeg: captions · brand · intro/outro
                 ▼
              final.mp4 (download in the app)
```

## Stack

- **Next.js** (App Router) — UI + API routes; the whole pipeline runs in-process
  on the Node server (local-first, no extra infra).
- **@cursor/sdk** — the planning/driving agent with custom browser tools.
- **@onkernel/sdk** — Kernel cloud browsers (free tier; recording is CDP
  screencast, no paid replay needed).
- **playwright-core** — connected straight to the Kernel browser's CDP websocket.
- **ffmpeg** — must be on PATH.

## Setup

```bash
cp .env.example .env   # fill in CURSOR_API_KEY + KERNEL_API_KEY
npm install
npm run dev
```

## Engine smoke test (no UI)

```bash
npm run smoke -- "show the referral leaderboard and open the top referrer" https://www.gamerplug.app/en/leaderboard
```

Outputs land in `data/jobs/<id>/` — `final.mp4`, `raw.mp4`, `recipe.json`,
`report.json`. Recipes are deterministic and reusable: re-render a demo after a
UI change without calling the model again.

## Let your agent record demos (MCP)

Demo Studio is also an MCP server, so coding agents (Claude Code, Cursor,
Codex, …) can request demo videos themselves. The endpoint lives on the
standalone backend at `/mcp` (streamable HTTP, stateless) and exposes two
tools:

- `create_demo_video({ goal, startUrl })` — kicks off an autonomous run
  (the agent plans and records without a confirmation turn) and returns a
  `runId` plus a **stable `watchUrl`** that works while the video is still
  generating.
- `get_demo_video({ runId })` — poll status: `planning → recording →
  composing → done | error`, with `liveViewUrl` while recording.

Both tools include a `shareable` flag on every response: `true` only when the
`watchUrl` opens from other machines. A backend without `PUBLIC_URL` builds
links from the request host — `localhost` for a local MCP client — and marks
them `shareable: false` so agents don't paste dead links into PRs or chat.
Once a run is `done` and Supabase storage is configured, `watchUrl` switches
to the durable public MP4, which stays up after the backend shuts down.

Stable links served by the backend:

- `GET /api/runs/:runId` — JSON status (includes the action log)
- `GET /api/runs/:runId/video` — `202` while generating, `410` on failure,
  `302` once done (`?download` for attachment) — to the Supabase storage copy
  when configured, else to the local file

`/mcp` is protected with OAuth (the standard MCP authorization flow): an
unauthenticated request gets a `401` with a `WWW-Authenticate` challenge, the
client discovers Clerk via `/.well-known/oauth-protected-resource/mcp`,
registers itself dynamically, and opens a browser for the user to sign in —
`claude mcp add` handles all of this automatically. Requirements on the
server: `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY`, and **Dynamic client
registration** enabled in the Clerk dashboard (Configure → OAuth
applications). Videos created over MCP are attributed to the signed-in user
and appear in their library. Two escape hatches: `MCP_AUTH_TOKEN` (static
bearer accepted alongside OAuth, for CI) and `MCP_ALLOW_ANONYMOUS=1` (no auth,
bare local runs only — never set it on a public deployment).

Set `PUBLIC_URL` (see `.env.example`) so returned links use your
public host — without it, links are local-only and flagged as such. Set
`SUPABASE_URL` + `SUPABASE_SECRET_KEY` so finished videos are uploaded to a
public storage bucket instead of living solely on the recording machine's disk.

### Give these instructions to your agent

> I'd like you to set up Demo Studio: browser demo videos recorded by agents.
>
> Add the MCP server: `https://demo-studio-backend.fly.dev/mcp`
>
> Install the `/record-demo` skill: `npx skills add ionpetro/demo-studio`
>
> Then try this prompt: Use Demo Studio to record a short demo video of the
> most recent user-facing change. Pick the deployed page it affects as the
> start URL, describe the goal in one or two sentences, and create the video.
> Then add a comment on the PR with the watch URL.

With Claude Code specifically:

```bash
claude mcp add --transport http demo-studio https://demo-studio-backend.fly.dev/mcp
npx skills add ionpetro/demo-studio
```

The skill (`skills/record-demo/SKILL.md`) tells the agent when a video is
worth making (PR walkthroughs, visual bugs, feature demos), when it isn't
(logins, unfinished work, sensitive data), and to only share the watch URL
when the server marks it `shareable`.

Local test without deploying (with Clerk keys in `.env` the OAuth flow works
locally too; set `MCP_ALLOW_ANONYMOUS=1` to skip auth entirely):

```bash
npm run backend           # serves /mcp on :3001
claude mcp add --transport http demo-studio http://localhost:3001/mcp
```

Local runs hand out `localhost` links flagged `shareable: false`; once a run
finishes with Supabase storage configured, `get_demo_video` returns the
durable public URL instead.
