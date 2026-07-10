import { auth } from "@clerk/nextjs/server";
import { getSession } from "@/engine/agent-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_ID = /^sess-[a-z0-9-]+$/;

/** The login-handoff Continue button: resolves a pending request_login wait. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!SESSION_ID.test(id)) return Response.json({ error: "invalid session id" }, { status: 400 });

  const { userId } = await auth();
  if (!userId) return Response.json({ error: "sign in required" }, { status: 401 });

  // getSession (not getOrCreate): confirming can't spawn sessions, and a
  // session with no pending login is a 409 either way.
  const session = getSession(id);
  if (!session?.confirmLogin()) return Response.json({ error: "no login pending" }, { status: 409 });
  return Response.json({ ok: true });
}
