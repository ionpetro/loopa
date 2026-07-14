import { auth } from "@clerk/nextjs/server";
import { getOrCreateSession } from "@/engine/agent-session";
import type { SessionEvent } from "@/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Agent turns can include long browser recordings. */
export const maxDuration = 300;

const SESSION_ID = /^sess-[a-z0-9-]+$/;

function sseBytes(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!process.env.OPENAI_API_KEY || !process.env.KERNEL_API_KEY) {
    return jsonError(
      "Set OPENAI_API_KEY and KERNEL_API_KEY in the deployment environment, then redeploy.",
      500,
    );
  }

  const { id } = await params;
  if (!SESSION_ID.test(id)) return jsonError("invalid session id", 400);

  let body: { message?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    return jsonError("message required", 400);
  }

  const { userId } = await auth();
  if (!userId) return jsonError("sign in required", 401);

  const session = getOrCreateSession(id);
  session.setUser(userId);
  if (session.isBusy) return jsonError("agent is busy", 409);
  if (typeof body.model === "string" && /^[a-z0-9.-]{1,40}$/.test(body.model)) {
    session.setModel(body.model);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: SessionEvent) => {
        try {
          controller.enqueue(sseBytes(ev));
        } catch {
          /* client disconnected */
        }
      };

      // Heartbeat so long silent stretches (ffmpeg compose) don't get the
      // stream culled as idle by proxies.
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch {
          /* client disconnected */
        }
      }, 20_000);

      const unsubscribe = session.subscribe(send);
      try {
        await session.handleMessage(message.trim());
      } finally {
        clearInterval(keepalive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
