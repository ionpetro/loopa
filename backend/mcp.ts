/**
 * MCP server for Demo Studio — lets external coding agents (Claude Code,
 * Cursor, Codex, …) request demo videos over streamable HTTP at /mcp.
 *
 * Stateless: a fresh McpServer + transport is created per request, so no MCP
 * session affinity is needed. Runs themselves live in the engine's run
 * registry (src/engine/headless-run.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startDemoRun, loadDemoRun, type DemoRun } from "../src/engine/headless-run.ts";
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
  "do NOT paste it into PRs, issues, or chat. When the run is done, get_demo_video returns a " +
  "durable public link if video storage is configured.";

/** Web-app base for watch-page links (FRONTEND_URL may be a comma list for CORS). */
function frontendBase(): string {
  const first = (process.env.FRONTEND_URL ?? "").split(",")[0].trim().replace(/\/$/, "");
  return first || "http://localhost:3000";
}

async function runSnapshot(run: DemoRun, baseUrl: string) {
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
  return {
    runId: run.id,
    status: run.status,
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
  const server = new McpServer({ name: "demo-studio", version: "0.1.0" });

  server.registerTool(
    "create_demo_video",
    {
      title: "Create demo video",
      description:
        "Record a short browser demo video. An agent drives a real cloud browser through the goal on a live " +
        "web page, captures every frame, and composes a captioned, branded MP4. Returns immediately " +
        "with a runId; generation takes a few minutes — poll get_demo_video until status is 'done'. " +
        "Once recording starts, watchUrl is the video's watch page in the Demo Studio web app — that is " +
        "the link to share. Only paste it into PRs, issues, or messages when the response marks it " +
        "shareable: true — a local-only deployment hands out links that only resolve locally. " +
        "Pages behind a login work only if the user has previously signed in to that site through the " +
        "Demo Studio web app (their saved browser session is reused); otherwise the run fails with " +
        "'login required'. " +
        "CAUTION: the agent will follow the goal literally, including submitting forms, and " +
        "finished videos are viewable by anyone with the link — never include credentials or goals that " +
        "pay for anything or destroy data.",
      inputSchema: {
        goal: z.string().min(1).max(500).describe("What the video should demonstrate, in one or two sentences."),
        startUrl: z
          .string()
          .url()
          .describe(
            "Full https:// URL of the page where the demo starts. Infer it when the user names a site " +
              "casually ('go on google' → https://www.google.com); only ask if the domain is genuinely ambiguous.",
          ),
      },
    },
    async ({ goal, startUrl }) => {
      log.info("mcp", `create_demo_video user=${userId ?? "anon"} client=${clientId ?? "-"} startUrl=${startUrl} goal="${clip(goal)}"`);
      let run;
      try {
        run = await startDemoRun(goal, startUrl, userId, clientId);
      } catch (err) {
        log.warn("mcp", `create_demo_video rejected: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
      const snap = await runSnapshot(run, baseUrl);
      return asText({
        ...snap,
        note: snap.shareable
          ? "Video generation started. Poll get_demo_video every ~30s until status is 'done'; once recording starts, watchUrl is the video's watch page — share that link."
          : "Video generation started. Do NOT share this watchUrl — it is local-only. Poll get_demo_video every ~30s; when status is 'done' it returns a shareable link if storage is configured.",
      });
    },
  );

  server.registerTool(
    "get_demo_video",
    {
      title: "Get demo video status",
      description:
        "Check the status of a demo video run created with create_demo_video. Status is one of: planning, " +
        "recording, composing, done, error. When 'done', the watchUrl is the video's watch page.",
      inputSchema: {
        runId: z.string().describe("The runId returned by create_demo_video."),
      },
    },
    async ({ runId }) => {
      // DB fallback so polls keep working across a backend restart mid-run.
      const run = await loadDemoRun(runId);
      log.info("mcp", `get_demo_video ${runId} → ${run ? run.status : "not found"}`);
      if (!run) return { ...asText({ error: `no run with id ${runId}` }), isError: true };
      return asText(await runSnapshot(run, baseUrl));
    },
  );

  return server;
}
