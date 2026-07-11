---
name: record-loopa
description: |
  Record a short cloud agent loopa of a live web page using Loopa. An
  agent drives a real cloud browser through a goal you describe and produces a
  captioned, branded MP4 with a shareable link. Use it for feature walkthroughs, PR
  reviews of deployed UI changes, bug reproductions on public pages, or
  onboarding walkthroughs. Do not use it for pages behind a login, flows that
  change data, unfinished work, or anything exposing sensitive information.
author: Loopa
---

# Record loopa

Loopa is a cloud agent recorder. Use this skill when a
recorded walkthrough of a live page is clearer than another chat message.

## Setup and auth

The MCP endpoint is protected with OAuth. Adding the server triggers the
standard MCP sign-in flow (a browser window to authenticate):

```bash
claude mcp add --transport http loopa https://api.loopa.sh/mcp
```

Loopas are attributed to the signed-in user and appear in their Loopa
library. If a tool call fails with 401/unauthorized, the token expired or was
revoked — ask the user to re-authenticate (in Claude Code: `/mcp` → select
loopa → Authenticate). Do not retry the call until they have.

## Use when

- The user asks for a loopa, walkthrough, or video of a live web page.
- You shipped or reviewed a UI change that is deployed somewhere public and a
  before/after or feature walkthrough would help reviewers.
- A PR touches user-facing flows and a recorded run of the deployed preview
  would make review faster.
- A visual bug is easiest to explain by recording the reproduction.

## Don't use when

- The page requires logging in, signing up, or paying — Loopa only
  records public pages and never changes data.
- The change is not deployed anywhere reachable by URL yet.
- The answer is short and textual, or the user is actively iterating in chat.
- The recording could expose secrets, tokens, or private data.
- The user explicitly says not to create a video.

## How to use

1. Call `create_loopa` with:
   - `goal` — one or two sentences describing what the loopa should show.
   - `startUrl` — the full https:// URL of the page where the loopa starts.
     Infer it when the user names a site casually ("go on google" →
     `https://www.google.com`); don't ask them to spell out a URL. If the
     domain is ambiguous, suggest one and proceed once they agree.
2. It returns immediately with a `runId` and a stable `watchUrl`. Check the
   `shareable` flag: when `true`, share the `watchUrl` right away — it works
   while the video is still generating. When `false` (a local backend without
   a public URL), the link only resolves on that machine — never paste it into
   PRs, issues, or chat; wait for `done` and use the link `get_loopa`
   returns then, which is durable when it is marked `shareable`.
3. Generation takes a few minutes. Poll `get_loopa` with the `runId`
   roughly every 30 seconds until `status` is `done` (or `error`). Failed runs
   include the failure reason in `error` — report it verbatim.
4. While recording, `liveViewUrl` lets a human watch the browser live.
5. Sites behind aggressive bot protection (e.g. Cloudflare challenges) may
   show a verification wall instead of the page — if the action log shows the
   agent stuck on one, tell the user and suggest a different target page.

## Output format

After using Loopa, respond with:

- the `watchUrl`, but only post it outside the chat (PRs, issues, messages)
  when the response marks it `shareable: true`; otherwise say the link is
  local-only and where a shareable one will come from
- a one-sentence description of what the loopa covers
- if the run errored, say so plainly and include the error message