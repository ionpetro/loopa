import { Container, getContainer } from "@cloudflare/containers";

/** Worker secrets forwarded into the container's environment. */
const SECRET_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "KERNEL_API_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "MCP_AUTH_TOKEN",
] as const;

interface LoopaEnv extends Partial<Record<(typeof SECRET_NAMES)[number], string>> {
  LOOPA: DurableObjectNamespace<LoopaBackend>;
  PUBLIC_URL: string;
  FRONTEND_URL: string;
  DAILY_RUN_LIMIT: string;
}

const PORT = 3001;

export class LoopaBackend extends Container<LoopaEnv> {
  defaultPort = PORT;
  // Short idle window keeps the bill low; recordings in progress are protected
  // by onActivityExpired below, not by this timer.
  sleepAfter = "3m";

  constructor(ctx: DurableObjectState<{}>, env: LoopaEnv) {
    super(ctx, env);
    const vars: Record<string, string> = {
      PORT: String(PORT),
      PUBLIC_URL: env.PUBLIC_URL,
      FRONTEND_URL: env.FRONTEND_URL,
      DAILY_RUN_LIMIT: env.DAILY_RUN_LIMIT,
    };
    for (const name of SECRET_NAMES) {
      const value = env[name];
      if (value) vars[name] = value;
    }
    this.envVars = vars;
  }

  /**
   * A recording runs for minutes with no inbound requests (the agent talks to
   * Kernel and OpenAI, not to us), so the idle timer alone would kill it.
   * Ask the backend whether work is in flight; returning without stop() renews
   * the timer and the hook fires again on the next expiry.
   */
  override async onActivityExpired(): Promise<void> {
    try {
      const res = await this.containerFetch(`http://container/health`);
      const { busy } = (await res.json()) as { busy?: number };
      if (busy && busy > 0) {
        console.log(`idle timer expired but ${busy} job(s)/run(s) in flight — staying up`);
        return;
      }
    } catch (err) {
      console.error("busy check failed — stopping anyway", err);
    }
    await this.stop();
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }) {
    console.log("container stopped", { exitCode, reason });
  }
}

/** How many times a request is replayed while the container is still waking up. */
const WAKE_RETRIES = 3;
/** The library's default port wait is 20s; a cold start has been seen at ~10s. */
const WAKE_TIMEOUT_MS = 60_000;

/**
 * Errors produced by the Container library itself (never by the backend, which
 * always answers JSON or SSE): the container failed to start in time, or the
 * connection dropped because it was shutting down for idle sleep.
 */
async function wakeFailure(res: Response, method: string): Promise<string | null> {
  if (res.status < 500 || !(res.headers.get("content-type") ?? "").startsWith("text/plain")) return null;
  const text = await res.clone().text();
  if (/Failed to start container|no Container instance available/.test(text)) return text;
  // The request may already have reached the old process — only replay reads.
  const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (idempotent && /suddenly disconnected|Network connection lost|Error proxying request/.test(text)) return text;
  return null;
}

/**
 * Library errors carry no CORS headers, so the browser reports only "Failed to
 * fetch". Add them for the frontend so the real status reaches the UI.
 */
function withCors(res: Response, request: Request, env: LoopaEnv): Response {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.FRONTEND_URL || res.headers.has("Access-Control-Allow-Origin")) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.append("Vary", "Origin");
  return out;
}

export default {
  // Single named instance: all traffic must reach the same in-memory sessions.
  async fetch(request: Request, env: LoopaEnv): Promise<Response> {
    const container = getContainer(env.LOOPA, "main");
    // Buffer the (small JSON) body so the request can be replayed after a wake failure.
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();

    for (let attempt = 1; ; attempt++) {
      const res = await container.fetch(new Request(request, { body }));
      const failure = attempt <= WAKE_RETRIES ? await wakeFailure(res, request.method) : null;
      if (!failure) return withCors(res, request, env);

      console.warn(`container not ready (attempt ${attempt}/${WAKE_RETRIES}): ${failure.slice(0, 200)}`);
      try {
        await container.startAndWaitForPorts({ cancellationOptions: { portReadyTimeoutMS: WAKE_TIMEOUT_MS } });
      } catch (err) {
        console.error("container start failed", err);
      }
    }
  },
} satisfies ExportedHandler<LoopaEnv>;
