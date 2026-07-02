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
  if (!process.env.CURSOR_API_KEY || !process.env.KERNEL_API_KEY) {
    return jsonError(
      "Set CURSOR_API_KEY and KERNEL_API_KEY in the deployment environment, then redeploy.",
      500,
    );
  }

  const { id } = await params;
  if (!SESSION_ID.test(id)) return jsonError("invalid session id", 400);

  let body: { message?: unknown };
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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: SessionEvent) => {
        try {
          controller.enqueue(sseBytes(ev));
        } catch {
          /* client disconnected */
        }
      };

      const unsubscribe = session.subscribe(send);
      try {
        await session.handleMessage(message.trim());
      } finally {
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
