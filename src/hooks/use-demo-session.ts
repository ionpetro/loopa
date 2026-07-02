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
  | { mode: "live"; jobId: string; liveViewUrl?: string; composing: boolean }
  | { mode: "done"; jobId: string; videoUrl: string; durationSec: number };

export interface Tick {
  n: number;
  action: string;
  caption: string;
  ok: boolean;
}

type SessionEvent =
  | { type: "agent_text"; text: string }
  | { type: "agent_turn_done" }
  | { type: "tool_call"; name: string }
  | { type: "plan"; goal: string; startUrl: string }
  | { type: "job_created"; jobId: string }
  | { type: "live_view"; url: string }
  | { type: "action"; n: number; action: string; caption: string; ok: boolean }
  | { type: "job_status"; status: string }
  | { type: "video_ready"; jobId: string; videoUrl: string; durationSec: number }
  | { type: "error"; message: string };

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;

const newSessionId = () =>
  `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

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
 * Owns the demo-studio session: streaming chat, messages, busy flag, and stage state.
 * Uses a single POST that returns SSE so session state stays on one serverless instance.
 */
export function useDemoSession() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<StageState>({ mode: "idle" });
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const { getToken } = useAuth();

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
          pushAssistantPart({
            type: "tool-call",
            toolCallId: uid("tc"),
            toolName: ev.name === "mcp" ? "studio_tool" : ev.name,
          });
          break;
        case "agent_turn_done":
          busyRef.current = false;
          setBusy(false);
          break;
        case "plan":
          setStage({ mode: "plan", goal: ev.goal, startUrl: ev.startUrl });
          break;
        case "job_created":
          setTicks([]);
          setError(null);
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
            setRecStart(null);
            setStage({ mode: "idle" });
          }
          break;
        case "video_ready":
          setRecStart(null);
          setStage({ mode: "done", jobId: ev.jobId, videoUrl: ev.videoUrl, durationSec: ev.durationSec });
          break;
        case "error":
          setError(ev.message);
          break;
      }
    },
    [pushAssistantPart],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busyRef.current) return;
      busyRef.current = true;
      setError(null);
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
          body: JSON.stringify({ message }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `request failed (${res.status})`);
        }

        if (!res.body) throw new Error("no response stream");

        for await (const ev of readSseEvents(res.body)) {
          handleEvent(ev);
        }
      } catch (err) {
        busyRef.current = false;
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [handleEvent, getToken],
  );

  return { messages, busy, stage, setStage, ticks, error, recStart, send };
}
