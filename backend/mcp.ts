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
  "This watchUrl only resolves on the machine running the backend (PUBLIC_URL is not set) — " +
  "do NOT paste it into PRs, issues, or chat. When the run is done, get_demo_video returns a " +
  "durable public link if video storage is configured.";

async function runSnapshot(run: DemoRun, baseUrl: string) {
  // Once done, prefer the durable storage copy (uploaded by finish_demo): it
  // outlives this process and plays from any machine, unlike the local file
  // behind /api/jobs/:id/video.
  const storedUrl =
    run.status === "done" && run.jobId ? ((await loadJobRecord(run.jobId))?.videoUrl ?? undefined) : undefined;
  const shareable = Boolean(storedUrl) || isShareableBase(baseUrl);
  return {
    runId: run.id,
    status: run.status,
    // Stable link — works as soon as the run exists, resolves to the MP4 once done.
    watchUrl: storedUrl ?? `${baseUrl}/api/runs/${run.id}/video`,
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
        "with a runId and a stable watchUrl; generation takes a few minutes — poll get_demo_video until " +
        "status is 'done'. Only paste the watchUrl into PRs, issues, or messages when the response marks " +
        "it shareable: true — a backend without a public URL hands out links that only resolve locally. " +
        "CAUTION: the agent will follow the goal literally, including logging in or submitting forms, and " +
        "finished videos are viewable by anyone with the link — never include credentials or goals that " +
        "pay for anything or destroy data.",
      inputSchema: {
        goal: z.string().min(1).max(500).describe("What the video should demonstrate, in one or two sentences."),
        startUrl: z.string().url().describe("Full https:// URL of the page where the demo starts."),
      },
    },
    async ({ goal, startUrl }) => {
      const run = await startDemoRun(goal, startUrl, userId, clientId);
      const snap = await runSnapshot(run, baseUrl);
      return asText({
        ...snap,
        note: snap.shareable
          ? "Video generation started. Share the watchUrl now (it is stable), then poll get_demo_video every ~30s until status is 'done'."
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
        "recording, composing, done, error. When 'done', the watchUrl serves the final MP4.",
      inputSchema: {
        runId: z.string().describe("The runId returned by create_demo_video."),
      },
    },
    async ({ runId }) => {
      // DB fallback so polls keep working across a backend restart mid-run.
      const run = await loadDemoRun(runId);
      if (!run) return { ...asText({ error: `no run with id ${runId}` }), isError: true };
      return asText(await runSnapshot(run, baseUrl));
    },
  );

  return server;
}
