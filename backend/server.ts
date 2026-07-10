/**
 * Standalone API server for Railway — same routes as the Next.js API handlers,
 * without the UI bundle.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { verifyToken } from "@clerk/backend";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { disposeAllSessions, getOrCreateSession, getSession } from "../src/engine/agent-session.ts";
import { failStaleWork, flushDb } from "../src/engine/db.ts";
import type { SessionEvent } from "../src/engine/types.ts";
import { jobDir, sweepOldJobDirs } from "../src/engine/jobs.ts";
import { failAllActiveRuns, loadDemoRun } from "../src/engine/headless-run.ts";
import { listUserJobs, loadJobRecord } from "../src/engine/db.ts";
import { getAuthor } from "../src/engine/author.ts";
import { log } from "../src/engine/log.ts";
import { buildMcpServer } from "./mcp.ts";
import { authorizeMcp, authServerMetadata, protectedResourceMetadata, wwwAuthenticate } from "./mcp-auth.ts";

const PORT = Number(process.env.PORT ?? 3001);

function loadDotEnv() {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadDotEnv();

const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "https://demo-studio-three.vercel.app",
];

function allowedOrigins(): string[] {
  const fromEnv = (process.env.FRONTEND_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ORIGINS, ...fromEnv])];
}

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const list = allowedOrigins();
  if (list.includes("*") || list.includes(origin)) return true;
  if (process.env.ALLOW_VERCEL_ORIGINS === "0") return false;
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === "https:" && hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

function cors(origin: string | undefined): Record<string, string> {
  if (!isOriginAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    // Browser-based MCP clients must be able to read the OAuth challenge.
    "Access-Control-Expose-Headers": "WWW-Authenticate",
    Vary: "Origin",
  };
}

/** Public base URL for links returned to agents (watchUrl etc.). */
function publicBase(req: http.IncomingMessage): string {
  const fromEnv = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? "http";
  return `${proto}://${req.headers.host ?? `localhost:${boundPort}`}`;
}

/**
 * Resolve the Clerk user for a request. Returns the user id, undefined when
 * Clerk isn't configured (auth disabled, e.g. bare local runs), or null for
 * an invalid/missing token when Clerk IS configured.
 */
async function clerkUserId(req: http.IncomingMessage): Promise<string | undefined | null> {
  if (!process.env.CLERK_SECRET_KEY) return undefined;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return claims.sub;
  } catch {
    return null;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown, origin?: string) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...cors(origin),
  });
  res.end(payload);
}

// /mcp is reachable unauthenticated by default (MCP_AUTH_TOKEN is optional), so
// an unbounded body would let an anonymous caller OOM the ~1GB box. Cap it and
// surface a taggable error the handlers turn into a 413.
const MAX_BODY_BYTES = 1024 * 1024; // 1MB — request bodies here are tiny JSON.
class PayloadTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(origin));
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    json(res, 200, { ok: true }, origin);
    return;
  }

  // --- OAuth discovery (MCP authorization spec) -----------------------------
  // Public by requirement: MCP clients fetch these anonymously (possibly from a
  // browser) to find the authorization server before they have any token.
  if (req.method === "GET" && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(pathname)) {
    const payload = JSON.stringify(protectedResourceMetadata(publicBase(req)));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(payload);
    return;
  }
  if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    // Proxied from Clerk for older clients that discover on the resource origin.
    const meta = await authServerMetadata();
    if (!meta) {
      json(res, 404, { error: "OAuth is not configured on this server" }, origin);
      return;
    }
    const payload = JSON.stringify(meta);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(payload);
    return;
  }

  // --- MCP endpoint (streamable HTTP, stateless) ---------------------------
  if (pathname === "/mcp") {
    const auth = await authorizeMcp(req);
    if (!auth) {
      // Standard OAuth challenge: clients follow resource_metadata to Clerk,
      // register dynamically, run PKCE, and retry with a bearer token.
      const payload = JSON.stringify({ error: "invalid_token", error_description: "Missing or invalid access token" });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "WWW-Authenticate": wwwAuthenticate(publicBase(req)),
        ...cors(origin),
      });
      res.end(payload);
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, origin);
      return;
    }
    if (!process.env.CURSOR_API_KEY || !process.env.KERNEL_API_KEY) {
      json(res, 500, { error: "CURSOR_API_KEY and KERNEL_API_KEY must be set on the server." }, origin);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        json(res, 413, { jsonrpc: "2.0", error: { code: -32000, message: "Payload too large" }, id: null }, origin);
        return;
      }
      json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, origin);
      return;
    }
    const mcpServer = buildMcpServer(publicBase(req), auth.userId, auth.clientId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // --- Run status + stable watch URL for MCP-created runs ------------------
  const runMatch = pathname.match(/^\/api\/runs\/(run-[a-z0-9-]+)(\/video)?$/);
  if (req.method === "GET" && runMatch) {
    const run = await loadDemoRun(runMatch[1]);
    if (!run) {
      json(res, 404, { error: "run not found" }, origin);
      return;
    }
    const wantsVideo = Boolean(runMatch[2]);
    if (wantsVideo && run.status === "done" && run.jobId) {
      // Prefer the durable storage copy — the local file only exists on the
      // machine that recorded the job (and only while that process's disk lives).
      const stored = (await loadJobRecord(run.jobId))?.videoUrl;
      const location = stored
        ? url.searchParams.has("download") ? `${stored}?download=${run.jobId}.mp4` : stored
        : `/api/jobs/${run.jobId}/video${url.search}`;
      res.writeHead(302, { Location: location, ...cors(origin) });
      res.end();
      return;
    }
    // Not (yet) watchable: report status. 202 = still generating, 410 = failed.
    const status = !wantsVideo ? 200 : run.status === "error" ? 410 : 202;
    json(res, status, {
      runId: run.id,
      status: run.status,
      jobId: run.jobId,
      liveViewUrl: run.liveViewUrl,
      durationSec: run.durationSec,
      error: run.error,
      actions: run.actions,
    }, origin);
    return;
  }

  // --- Video library (signed-in user's finished videos) ---------------------
  if (req.method === "GET" && pathname === "/api/me/videos") {
    const userId = await clerkUserId(req);
    if (!userId) {
      json(res, 401, { error: "sign in required" }, origin);
      return;
    }
    json(res, 200, { videos: await listUserJobs(userId) }, origin);
    return;
  }

  // --- Public watch-page metadata (the video URL itself is already public) ---
  const watchMatch = pathname.match(/^\/api\/videos\/(job-[a-z0-9-]+)$/);
  if (req.method === "GET" && watchMatch) {
    const job = await loadJobRecord(watchMatch[1]);
    if (!job || job.status !== "done" || !job.videoUrl) {
      json(res, 404, { error: "video not found" }, origin);
      return;
    }
    const author = await getAuthor(job.userId);
    json(res, 200, { ...job, userId: undefined, author }, origin);
    return;
  }

  // The login-handoff Continue button: resolves a pending request_login wait.
  const loginDoneMatch = pathname.match(/^\/api\/session\/(sess-[a-z0-9-]+)\/login-done$/);
  if (req.method === "POST" && loginDoneMatch) {
    const userId = await clerkUserId(req);
    if (userId === null) {
      json(res, 401, { error: "sign in required" }, origin);
      return;
    }
    const session = getSession(loginDoneMatch[1]);
    if (!session?.confirmLogin()) {
      json(res, 409, { error: "no login pending" }, origin);
      return;
    }
    json(res, 200, { ok: true }, origin);
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/session\/(sess-[a-z0-9-]+)$/);
  if (req.method === "POST" && sessionMatch) {
    if (!process.env.CURSOR_API_KEY || !process.env.KERNEL_API_KEY) {
      json(res, 500, { error: "CURSOR_API_KEY and KERNEL_API_KEY must be set on the server." }, origin);
      return;
    }

    const userId = await clerkUserId(req);
    if (userId === null) {
      json(res, 401, { error: "sign in required" }, origin);
      return;
    }

    const session = getOrCreateSession(sessionMatch[1]);
    session.setUser(userId);
    let message: unknown;
    let model: unknown;
    try {
      const body = JSON.parse(await readBody(req));
      message = body.message;
      model = body.model;
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        json(res, 413, { error: "request body too large" }, origin);
        return;
      }
      json(res, 400, { error: "invalid json" }, origin);
      return;
    }
    if (typeof model === "string" && /^[a-z0-9.-]{1,40}$/.test(model)) {
      session.setModel(model);
    }
    if (typeof message !== "string" || !message.trim()) {
      json(res, 400, { error: "message required" }, origin);
      return;
    }
    if (session.isBusy) {
      json(res, 409, { error: "agent is busy" }, origin);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...cors(origin),
    });

    const send = (ev: SessionEvent) => {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        cleanup();
      }
    };

    // Comment-line heartbeat: composing (ffmpeg + storage upload) can go
    // minutes without events, and idle streams get cut by proxies — which the
    // UI surfaced as "network error" right at the developing-film moment.
    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        cleanup();
      }
    }, 20_000);

    const unsubscribe = session.subscribe(send);
    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe();
    };

    try {
      await session.handleMessage(message.trim());
    } finally {
      cleanup();
      res.end();
    }
    return;
  }

  const videoMatch = pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/video$/);
  if (req.method === "GET" && videoMatch) {
    const id = videoMatch[1];
    const file = path.join(jobDir(id), "final.mp4");
    const download = url.searchParams.has("download");
    if (!fs.existsSync(file)) {
      // Recorded on another machine (or the disk was wiped): fall back to the
      // durable storage copy so the stable link works from any instance.
      const stored = (await loadJobRecord(id))?.videoUrl;
      if (stored) {
        res.writeHead(302, { Location: download ? `${stored}?download=${id}.mp4` : stored, ...cors(origin) });
        res.end();
        return;
      }
      res.writeHead(404, cors(origin));
      res.end("video not found");
      return;
    }
    const stat = fs.statSync(file);

    const headers: Record<string, string> = {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      ...cors(origin),
      ...(download ? { "Content-Disposition": `attachment; filename="${id}.mp4"` } : {}),
    };
    res.writeHead(200, headers);
    const nodeStream = fs.createReadStream(file);
    nodeStream.pipe(res);
    return;
  }

  res.writeHead(404, cors(origin));
  res.end("not found");
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    // /health is hit by the platform every few seconds — pure noise.
    if (req.url === "/health" || req.method === "OPTIONS") return;
    log.info("http", `${req.method} ${req.url} → ${res.statusCode} in ${Date.now() - startedAt}ms`);
  });
  handle(req, res).catch((err) => {
    log.error("http", `${req.method} ${req.url} unhandled error`, err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

// Fall forward when the port is taken (a stale dev process, another local
// server) instead of dying — but only off the default; an explicitly
// configured PORT (Fly, docker port maps) must bind exactly or fail loudly.
let boundPort = PORT;
let portFallbacksLeft = process.env.PORT ? 0 : 10;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && portFallbacksLeft > 0) {
    portFallbacksLeft--;
    log.warn("http", `port ${boundPort} is in use — trying ${boundPort + 1}`);
    boundPort++;
    setTimeout(() => server.listen(boundPort), 100);
    return;
  }
  log.error("http", "server failed to start", err);
  process.exit(1);
});

server.listen(boundPort, () => {
  log.info("http", `demo-studio backend listening on :${boundPort}`);
  // Reclaim disk from old job dirs left by prior processes on this box.
  sweepOldJobDirs();
  // Boot reconciliation: a hard crash (OOM/SIGKILL) skips graceful shutdown,
  // leaving DB rows stuck in "recording"/"composing" while pollers see 202
  // forever. Nothing from a previous process can still be running.
  void failStaleWork("backend restarted while this was in progress — submit the demo again").then((res) => {
    if (res && (res.jobs || res.runs)) {
      log.info("boot", `failed ${res.jobs} stale job(s) and ${res.runs} stale run(s) from a previous process`);
    }
  });
});

// Graceful shutdown: a deploy/restart must fail open jobs (persisted to the
// DB) and close cloud browsers instead of leaving zombie "recording" rows.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", `${signal} — failing open jobs and closing browsers before exit`);
  const deadline = setTimeout(() => process.exit(1), 20_000);
  try {
    await disposeAllSessions("backend restarted mid-recording (deploy) — please run the demo again");
    // Synchronous: enqueues its persists before flushDb snapshots the chain.
    failAllActiveRuns("backend restarted mid-run (deploy) — submit the demo again");
    await flushDb();
  } finally {
    clearTimeout(deadline);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
