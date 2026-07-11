/**
 * MCP server for Loopa — lets external coding agents (Claude Code,
 * Cursor, Codex, …) request loopas over streamable HTTP at /mcp.
 *
 * Stateless: a fresh McpServer + transport is created per request, so no MCP
 * session affinity is needed. Runs themselves live in the engine's run
 * registry (src/engine/headless-run.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startLoopaRun, loadLoopaRun, getRunLoginState, confirmRunLogin, type LoopaRun } from "../src/engine/headless-run.ts";
import { loadJobRecord } from "../src/engine/db.ts";
import { clip, log } from "../src/engine/log.ts";

/**
 * Whether links built on this base URL open from other machines. Without
 * PUBLIC_URL the base falls back to the request Host — localhost for a local
 * MCP client — and those links are dead everywhere else (and here too once
 * the backend stops). Flagged so agents don't paste them into PRs or chat.
 */
function isShareableBase(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname)) return false;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const LOCAL_LINK_NOTE =
  "This watchUrl only resolves on machines that can reach the local frontend/backend — " +
  "do NOT paste it into PRs, issues, or chat. When the run is done, get_loopa returns a " +
  "durable public link if video storage is configured.";

/** Web-app base for watch-page links (FRONTEND_URL may be a comma list for CORS). */
function frontendBase(): string {
  const first = (process.env.FRONTEND_URL ?? "").split(",")[0].trim().replace(/\/$/, "");
  return first || "http://localhost:3000";
}

async function runSnapshot(run: LoopaRun, baseUrl: string, viewerUserId?: string) {
  // The watch page is the link agents share: it plays the video with title,
  // chapters, and author once composed. The jobId it's keyed on only exists
  // after recording starts, so until then fall back to the backend run URL.
  const pageUrl = run.jobId ? `${frontendBase()}/videos/${run.jobId}` : `${baseUrl}/api/runs/${run.id}/video`;
  const pageIsShareable = isShareableBase(run.jobId ? frontendBase() : baseUrl);
  // Local-only setup: once the run is done, the raw storage copy is the only
  // link that works off this machine.
  const storedUrl =
    !pageIsShareable && run.status === "done" && run.jobId
      ? ((await loadJobRecord(run.jobId))?.videoUrl ?? undefined)
      : undefined;
  const shareable = pageIsShareable || Boolean(storedUrl);
  // Ownership-gated: the login live view opens the browser the user types
  // credentials into, so it is only released to the run's owner.
  const login = run.status === "awaiting_login" ? getRunLoginState(run.id, viewerUserId) : undefined;
  return {
    runId: run.id,
    status: run.status,
    ...(login
      ? {
          loginUrl: login.url,
          loginDomain: login.domain,
          loginNote: login.hosted
            ? `The run is paused at a ${login.domain} login wall. Ask the user to open loginUrl — Kernel's secure ` +
              "hosted sign-in page — in their own browser (do NOT open it or enter credentials yourself). The run " +
              "resumes automatically once they finish; calling confirm_login afterwards is optional. It gives up " +
              "after 10 minutes."
            : `The run is paused at a ${login.domain} login wall. Ask the user to open loginUrl in their own browser ` +
              "and sign in there (do NOT open it or enter credentials yourself), then call confirm_login with this " +
              "runId. The run resumes automatically; it gives up after 10 minutes.",
        }
      : {}),
    watchUrl: pageIsShareable ? pageUrl : (storedUrl ?? pageUrl),
    shareable,
    ...(shareable ? {} : { linkNote: LOCAL_LINK_NOTE }),
    statusUrl: `${baseUrl}/api/runs/${run.id}`,
    liveViewUrl: run.liveViewUrl,
    durationSec: run.durationSec,
    error: run.error,
    actionsSoFar: run.actions.length,
    lastAction: run.actions.at(-1)?.caption,
  };
}

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function buildMcpServer(baseUrl: string, userId?: string, clientId?: string): McpServer {
  const server = new McpServer({ name: "loopa", version: "0.1.0" });

  server.registerTool(
    "create_loopa",
    {
      title: "Create loopa",
      description:
        "Record a short cloud agent loopa. An agent drives a real cloud browser through the goal on a live " +
        "web page, captures every frame, and composes a captioned, branded MP4. Returns immediately " +
        "with a runId; generation takes a few minutes — poll get_loopa until status is 'done'. " +
        "Once recording starts, watchUrl is the video's watch page in the Loopa web app — that is " +
        "the link to share. Only paste it into PRs, issues, or messages when the response marks it " +
        "shareable: true — a local-only deployment hands out links that only resolve locally. " +
        "Pages behind a login: if the user previously signed in to that site through Loopa, their saved " +
        "browser session is reused automatically. Otherwise the run pauses with status 'awaiting_login' " +
        "and get_loopa returns a loginUrl — ask the user to open it and sign in themselves, then call " +
        "confirm_login to resume. Never put credentials in the goal. " +
        "CAUTION: the agent will follow the goal literally, including submitting forms, and " +
        "finished loopas are viewable by anyone with the link — never include credentials or goals that " +
        "pay for anything or destroy data.",
      inputSchema: {
        goal: z.string().min(1).max(500).describe("What the loopa should demonstrate, in one or two sentences."),
        startUrl: z
          .string()
          .url()
          .describe(
            "Full https:// URL of the page where the loopa starts. Infer it when the user names a site " +
              "casually ('go on google' → https://www.google.com); only ask if the domain is genuinely ambiguous.",
          ),
      },
    },
    async ({ goal, startUrl }) => {
      log.info("mcp", `create_loopa user=${userId ?? "anon"} client=${clientId ?? "-"} startUrl=${startUrl} goal="${clip(goal)}"`);
      let run;
      try {
        run = await startLoopaRun(goal, startUrl, userId, clientId);
      } catch (err) {
        log.warn("mcp", `create_loopa rejected: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
      const snap = await runSnapshot(run, baseUrl, userId);
      return asText({
        ...snap,
        note: snap.shareable
          ? "Loopa generation started. Poll get_loopa every ~30s until status is 'done'; once recording starts, watchUrl is the video's watch page — share that link."
          : "Loopa generation started. Do NOT share this watchUrl — it is local-only. Poll get_loopa every ~30s; when status is 'done' it returns a shareable link if storage is configured.",
      });
    },
  );

  server.registerTool(
    "get_loopa",
    {
      title: "Get loopa status",
      description:
        "Check the status of a loopa run created with create_loopa. Status is one of: planning, " +
        "awaiting_login, recording, composing, done, error. When 'done', the watchUrl is the video's " +
        "watch page. When 'awaiting_login', the run is paused at a login wall: show the returned " +
        "loginUrl to the user, have them open it in their own browser and sign in (never open it or " +
        "enter credentials yourself), then call confirm_login.",
      inputSchema: {
        runId: z.string().describe("The runId returned by create_loopa."),
      },
    },
    async ({ runId }) => {
      // DB fallback so polls keep working across a backend restart mid-run.
      const run = await loadLoopaRun(runId);
      log.info("mcp", `get_loopa ${runId} → ${run ? run.status : "not found"}`);
      if (!run) return { ...asText({ error: `no run with id ${runId}` }), isError: true };
      return asText(await runSnapshot(run, baseUrl, userId));
    },
  );

  server.registerTool(
    "confirm_login",
    {
      title: "Confirm login",
      description:
        "Resume a loopa run paused with status 'awaiting_login'. Call this only after the user says " +
        "they finished signing in at the loginUrl returned by get_loopa — the run then continues with " +
        "the signed-in browser session.",
      inputSchema: {
        runId: z.string().describe("The runId of the run paused in 'awaiting_login'."),
      },
    },
    async ({ runId }) => {
      const result = confirmRunLogin(runId, userId);
      log.info("mcp", `confirm_login ${runId} user=${userId ?? "anon"} → ${result.ok ? "ok" : result.reason}`);
      if (!result.ok) return { ...asText({ error: result.reason }), isError: true };
      return asText({
        ok: true,
        runId,
        note: "Login confirmed — the run is resuming with the signed-in session. Keep polling get_loopa every ~30s until status is 'done'.",
      });
    },
  );

  return server;
}