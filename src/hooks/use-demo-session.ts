"use client";

import { useAuth } from "@clerk/nextjs";
import { apiUrl } from "@/lib/api-base";
import { useCallback, useRef, useState } from "react";

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
}

export type StageState =
  | { mode: "idle" }
  | { mode: "plan"; goal: string; startUrl: string }
  | { mode: "login"; liveViewUrl: string; domain: string }
  | { mode: "live"; jobId: string; liveViewUrl?: string; composing: boolean }
  | { mode: "done"; jobId: string; videoUrl: string; durationSec: number; chapters?: { title: string; start: number }[] };

export interface Tick {
  n: number;
  action: string;
  caption: string;
  ok: boolean;
}

export interface ComposeProgress {
  stage: string;
  pct?: number;
}

type SessionEvent =
  | { type: "agent_text"; text: string }
  | { type: "agent_turn_done" }
  | { type: "tool_call"; name: string }
  | { type: "plan"; goal: string; startUrl: string }
  | { type: "needs_login"; url: string; domain: string }
  | { type: "login_done" }
  | { type: "job_created"; jobId: string }
  | { type: "live_view"; url: string }
  | { type: "action"; n: number; action: string; caption: string; ok: boolean }
  | { type: "job_status"; status: string }
  | { type: "compose_progress"; stage: string; pct?: number }
  | { type: "video_ready"; jobId: string; videoUrl: string; durationSec: number; chapters?: { title: string; start: number }[] }
  | { type: "error"; message: string };

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;

// Unguessable session id: the session route accepts any client-supplied id, so
// a weak one would let others POST into your live agent session.
const newSessionId = () => `sess-${crypto.randomUUID()}`;

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SessionEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6)) as SessionEvent;
      split = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Owns the Loopa session: streaming chat, messages, busy flag, and stage state.
 * Uses a single POST that returns SSE so session state stays on one serverless instance.
 */
export function useLoopaSession() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<StageState>({ mode: "idle" });
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [compose, setCompose] = useState<ComposeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [model, setModel] = useState("composer-2.5");

  const sessionIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const liveJobRef = useRef<string | null>(null);
  // Last locked plan — the stage returns here when a login handoff finishes.
  const planRef = useRef<{ goal: string; startUrl: string } | null>(null);
  const { getToken } = useAuth();

  /**
   * The stream died mid-job but the backend keeps recording/composing —
   * poll the watch endpoint until the video lands (or ~4 min pass).
   */
  const recoverJob = useCallback(async (jobId: string): Promise<boolean> => {
    for (let i = 0; i < 48; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch(apiUrl(`/api/videos/${jobId}`));
        if (res.ok) {
          const v = (await res.json()) as {
            videoUrl: string;
            durationSec: number | null;
            chapters?: { title: string; start: number }[] | null;
          };
          liveJobRef.current = null;
          setRecStart(null);
          setError(null);
          setStage({ mode: "done", jobId, videoUrl: v.videoUrl, durationSec: v.durationSec ?? 0, chapters: v.chapters ?? undefined });
          return true;
        }
      } catch {
        /* transient — keep polling */
      }
    }
    return false;
  }, []);

  const pushAssistantPart = useCallback((part: ChatPart) => {
    setMessages((ms) => {
      const last = ms[ms.length - 1];
      if (last?.role === "assistant") {
        const parts = [...last.parts];
        const tail = parts[parts.length - 1];
        if (part.type === "text" && tail?.type === "text") {
          parts[parts.length - 1] = { type: "text", text: tail.text + part.text };
        } else {
          parts.push(part);
        }
        return [...ms.slice(0, -1), { ...last, parts }];
      }
      return [...ms, { id: uid("a"), role: "assistant", parts: [part] }];
    });
  }, []);

  const handleEvent = useCallback(
    (ev: SessionEvent) => {
      switch (ev.type) {
        case "agent_text":
          pushAssistantPart({ type: "text", text: ev.text });
          break;
        case "tool_call":
          pushAssistantPart({ type: "tool-call", toolCallId: uid("tc"), toolName: ev.name });
          break;
        case "agent_turn_done":
          busyRef.current = false;
          setBusy(false);
          break;
        case "plan":
          planRef.current = { goal: ev.goal, startUrl: ev.startUrl };
          setStage({ mode: "plan", goal: ev.goal, startUrl: ev.startUrl });
          break;
        case "needs_login":
          setStage({ mode: "login", liveViewUrl: ev.url, domain: ev.domain });
          break;
        case "login_done":
          setStage(planRef.current ? { mode: "plan", ...planRef.current } : { mode: "idle" });
          break;
        case "job_created":
          setTicks([]);
          setCompose(null);
          setError(null);
          liveJobRef.current = ev.jobId;
          setStage({ mode: "live", jobId: ev.jobId, composing: false });
          setRecStart(Date.now());
          break;
        case "live_view":
          setStage((s) => (s.mode === "live" ? { ...s, liveViewUrl: ev.url } : s));
          break;
        case "action":
          setTicks((t) => [...t.slice(-3), { n: ev.n, action: ev.action, caption: ev.caption, ok: ev.ok }]);
          break;
        case "job_status":
          if (ev.status === "composing") {
            setRecStart(null);
            setStage((s) => (s.mode === "live" ? { ...s, composing: true } : s));
          } else if (ev.status === "error") {
            liveJobRef.current = null;
            setRecStart(null);
            setCompose(null);
            setStage({ mode: "idle" });
          }
          break;
        case "compose_progress":
          setCompose({ stage: ev.stage, pct: ev.pct });
          break;
        case "video_ready":
          liveJobRef.current = null;
          setRecStart(null);
          setCompose(null);
          setStage({ mode: "done", jobId: ev.jobId, videoUrl: ev.videoUrl, durationSec: ev.durationSec, chapters: ev.chapters });
          break;
        case "error":
          setError(ev.message);
          break;
      }
    },
    [pushAssistantPart],
  );

  /** Tell a blocked request_login that the user finished logging in. */
  const confirmLogin = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      const token = await getToken().catch(() => null);
      const res = await fetch(apiUrl(`/api/session/${sessionId}/login-done`), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `request failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setAuthRequired(false);
      setBusy(true);
      setMessages((ms) => [...ms, { id: uid("u"), role: "user", parts: [{ type: "text", text: message }] }]);

      const sessionId = sessionIdRef.current ??= newSessionId();

      try {
        const token = await getToken().catch(() => null);
        const res = await fetch(apiUrl(`/api/session/${sessionId}`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ message, model }),
        });

        if (!res.ok) {
          // Signed-out users get a sign-up prompt in chat, not an error banner.
          if (res.status === 401) {
            busyRef.current = false;
            setBusy(false);
            setAuthRequired(true);
            return;
          }
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `request failed (${res.status})`);
        }

        if (!res.body) throw new Error("no response stream");

        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("text/event-stream")) {
          throw new Error(`expected event stream, got ${ct || res.status}`);
        }

        for await (const ev of readSseEvents(res.body)) {
          handleEvent(ev);
        }
      } catch (err) {
        const jobId = liveJobRef.current;
        if (jobId) {
          setError("connection dropped — waiting for Loopa to finish the cut…");
          if (await recoverJob(jobId)) return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        // Stream can close without agent_turn_done (e.g. Clerk middleware HTML 404).
        if (busyRef.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [handleEvent, getToken, recoverJob, model],
  );

  return { messages, busy, stage, setStage, ticks, compose, error, authRequired, recStart, send, confirmLogin, model, setModel };
}
