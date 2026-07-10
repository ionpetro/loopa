"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { SignUpButton } from "@clerk/nextjs";
import { CheckIcon, CopyIcon, DownloadIcon, LockKeyholeOpenIcon, PanelRightCloseIcon, PanelRightOpenIcon, RotateCcwIcon, SquareArrowOutUpRightIcon, VideoIcon } from "lucide-react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  Plan,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { WebPreview, WebPreviewBody, WebPreviewNavigation, WebPreviewUrl } from "@/components/ai-elements/web-preview";
import { Button } from "@/components/ui/button";
import { StudioHeader } from "@/components/studio-header";
import { DemoPlayer } from "@/components/demo-player";
import { LoopaLoader } from "@/components/loopa-loader";
import { useDemoSession, type ChatMessage, type ChatPart } from "@/hooks/use-demo-session";
import { apiBase } from "@/lib/api-base";
import { cn } from "@/lib/utils";

function fmtTimecode(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  const ff = String(Math.floor((ms % 1000) / 40)).padStart(2, "0");
  return `${mm}:${ss}:${ff}`;
}

// Poppins (our font-mono alias) has no tabular figures, so tabular-nums is a
// no-op and a ticking timecode makes the whole header bar jitter. Fixed-width
// cells per character keep the layout still.
function Timecode({ ms }: { ms: number }) {
  return (
    <span className="flex" aria-label={fmtTimecode(ms)}>
      {fmtTimecode(ms)
        .split("")
        .map((ch, i) => (
          <span key={i} className={cn("text-center", ch === ":" ? "w-[0.5ch]" : "w-[1.1ch]")}>
            {ch}
          </span>
        ))}
    </span>
  );
}

function agentInstructions(): string {
  const base = apiBase() || "http://localhost:3001";
  return `I'd like you to set up Demo Studio: browser demo videos recorded by agents.

Add the MCP server: ${base}/mcp

Install the /record-demo skill: npx skills add ionpetro/demo-studio

Then try this prompt: Use Demo Studio to record a short demo video of the most recent user-facing change. Pick the deployed page it affects as the start URL, describe the goal in one or two sentences, and create the video. Then add a comment on the PR with the watch URL.`;
}

function CopyAgentInstructions() {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="font-mono text-[10px] uppercase tracking-[0.18em]"
      onClick={() => {
        navigator.clipboard.writeText(agentInstructions()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
      {copied ? "copied" : "copy instructions"}
    </Button>
  );
}

/** Friendly labels for tool calls surfaced in chat; unknown names fall back to the raw name. */
const TOOL_LABELS: Record<string, string> = {
  // studio tools
  plan: "locking the shot list",
  login: "waiting for sign-in",
  roll: "rolling camera",
  action: "driving the browser",
  observe: "checking the page",
  wrap: "wrapping the take",
  cut: "developing the cut",
  // cursor sdk built-ins
  glob: "scanning files",
  grep: "searching files",
  read: "reading files",
  write: "writing files",
  edit: "editing files",
  ls: "listing files",
  shell: "running commands",
};

const toolLabel = (name: string) => TOOL_LABELS[name] ?? name.replaceAll("_", " ");

type MessageItem =
  | { type: "text"; text: string }
  | { type: "tools"; names: string[] };

/** Consecutive tool calls collapse into one activity line that updates in place. */
function groupParts(parts: ChatPart[]): MessageItem[] {
  const items: MessageItem[] = [];
  for (const part of parts) {
    const last = items[items.length - 1];
    if (part.type === "text") {
      items.push({ type: "text", text: part.text });
    } else if (last?.type === "tools") {
      last.names.push(part.toolName);
    } else {
      items.push({ type: "tools", names: [part.toolName] });
    }
  }
  return items;
}

function ToolActivity({ names }: { names: string[] }) {
  const label = toolLabel(names[names.length - 1]);
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
      <span className="text-ok">✓</span>
      {/* keyed remount replays the rise-in whenever the streaming label changes */}
      <span key={`${names.length}-${label}`} className="tool-swap">
        {label}
      </span>
      {names.length > 1 && <span className="text-muted-foreground/40">×{names.length}</span>}
    </div>
  );
}

function ChatMessageView({ message }: { message: ChatMessage }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {groupParts(message.parts).map((item, i) =>
          item.type === "text" ? (
            <MessageResponse key={i}>{item.text}</MessageResponse>
          ) : (
            <ToolActivity key={i} names={item.names} />
          ),
        )}
      </MessageContent>
    </Message>
  );
}

const COMPOSE_STAGES = ["processing frames", "printing captions", "encoding cut", "uploading to storage"];

/** Curated slice of the Cursor model catalog (all billed via CURSOR_API_KEY). */
const MODELS = [
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

export default function Home() {
  const { messages, busy, stage, setStage, ticks, compose, error, authRequired, recStart, send, confirmLogin, model, setModel } = useDemoSession();
  const [clock, setClock] = useState(0);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (recStart == null) return;
    const t = setInterval(() => setClock(Date.now() - recStart), 80);
    return () => clearInterval(t);
  }, [recStart]);

  const recording = stage.mode === "live" && !stage.composing;
  const lastMessage = messages[messages.length - 1];
  const awaitingReply = busy && lastMessage?.role === "user";

  // The stage only opens once the agent is actually doing something (plan
  // locked, browser live, or a finished cut) — before that it's chat-only.
  // Manual collapse survives until the next activity burst re-opens it.
  const stageActive = stage.mode !== "idle";
  const [stageCollapsed, setStageCollapsed] = useState(false);
  useEffect(() => {
    if (stageActive) setStageCollapsed(false);
  }, [stageActive]);
  const stageOpen = stageActive && !stageCollapsed;

  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput("");
    void send(text).catch(() => {});
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── producer rail ───────────────────────────────────────────── */}
      <aside className="flex min-w-0 flex-1 flex-col bg-background">
        <StudioHeader>
          {stageActive && stageCollapsed && (
            <button
              type="button"
              title="Open the stage"
              onClick={() => setStageCollapsed(false)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <PanelRightOpenIcon className="size-4" />
            </button>
          )}
        </StudioHeader>

        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-5 px-4 py-5">
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-10 py-10 text-center">
                <div className="hero-rise flex flex-col items-center gap-4">
                  <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                    <span className="rec-dot size-1.5 rounded-full bg-rec" />
                    ready
                  </span>
                  <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight">
                    What are we
                    <br />
                    looping today?
                  </h1>
                  <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                    Describe the flow — I&apos;ll storyboard it, film a live browser on camera, and
                    hand you the cut.
                  </p>
                </div>

                <div className="hero-rise flex flex-col items-center gap-2" style={{ animationDelay: "140ms" }}>
                  <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
                    or use your agent
                  </div>
                  <CopyAgentInstructions />
                </div>
              </div>
            ) : (
              messages.map((m) => <ChatMessageView key={m.id} message={m} />)
            )}
            {authRequired && (
              <Message from="assistant">
                <MessageContent>
                  <MessageResponse>
                    You&apos;ll need an account before I can roll camera — it only takes a moment.
                  </MessageResponse>
                  <SignUpButton>
                    <Button size="sm" className="w-fit">
                      sign up to continue
                    </Button>
                  </SignUpButton>
                </MessageContent>
              </Message>
            )}
            {awaitingReply && (
              <Shimmer className="font-mono text-xs uppercase tracking-widest">rolling…</Shimmer>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {error && (
          <div className="mx-4 mb-2 rounded-md border border-rec/40 bg-rec/10 px-3 py-2 font-mono text-xs text-rec">
            {error}
          </div>
        )}

        <div className="p-4">
          <PromptInput className="mx-auto w-full max-w-3xl" onSubmit={({ text }) => submit(text)}>
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="What should we record today?"
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputSelect value={model} onValueChange={setModel}>
                  <PromptInputSelectTrigger className="h-7 gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    <PromptInputSelectValue placeholder="model" />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {MODELS.map((m) => (
                      <PromptInputSelectItem key={m.id} value={m.id}>
                        {m.label}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              </PromptInputTools>
              <PromptInputSubmit disabled={busy} status={busy ? "submitted" : "ready"} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </aside>

      {/* ── stage — slides open when the agent starts working ─────────── */}
      <main
        className="flex shrink-0 flex-col overflow-hidden border-l bg-bg-deep transition-[width] duration-500 ease-in-out"
        style={{ width: stageOpen ? "calc(100% - 26.25rem)" : "0px" }}
        aria-hidden={!stageOpen}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <span className={cn("flex items-center gap-2", recording && "text-rec")}>
            <span className={cn("size-2 rounded-full bg-current", recording && "rec-dot")} />
            {recording ? "rec" : stage.mode === "done" ? "wrap" : stage.mode === "login" ? "private" : "standby"}
          </span>
          <span>cloud</span>
          <span className="flex items-center gap-3">
            <Timecode ms={recording ? clock : 0} />
            <button
              type="button"
              title="Collapse the stage"
              onClick={() => setStageCollapsed(true)}
              className="transition-colors hover:text-foreground"
            >
              <PanelRightCloseIcon className="size-4" />
            </button>
          </span>
        </div>

        <div className="relative flex min-h-0 min-w-[32rem] flex-1 items-center justify-center p-6">
          <div
            className={cn(
              "relative flex w-full flex-col overflow-hidden rounded-xl border bg-background shadow-[0_0_80px_-20px_oklch(0_0_0/60%)]",
              // Live/done: the card hugs the media frame (16:10 browser, 16:9
              // video) instead of stretching — no letterbox bars. Width capped
              // so chrome + media always fit the available height.
              stage.mode === "live" || stage.mode === "done" || stage.mode === "login" ? "max-h-full" : "h-full",
              recording && "border-rec/50 ring-1 ring-rec/30",
            )}
            style={
              stage.mode === "live" || stage.mode === "login"
                ? { maxWidth: "calc((100vh - 9.25rem) * 1.6)" }
                : stage.mode === "done"
                  ? { maxWidth: "calc((100vh - 10.75rem) * 1.7778)" }
                  : undefined
            }
          >
            {stage.mode === "plan" && (
              <div className="flex flex-1 items-center justify-center p-10">
                <Plan defaultOpen className="w-full max-w-xl">
                  <PlanHeader>
                    <div className="flex flex-col gap-1.5">
                      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                        shot list locked
                      </div>
                      <PlanTitle>{stage.goal}</PlanTitle>
                      <PlanDescription>
                        A live cloud browser will be driven on camera, then composed into a finished
                        cut.
                      </PlanDescription>
                    </div>
                  </PlanHeader>
                  <PlanContent className="flex flex-col gap-2 font-mono text-xs">
                    <div className="flex justify-between gap-6 border-t pt-2">
                      <span className="uppercase tracking-widest text-muted-foreground">opens at</span>
                      <span className="truncate">{stage.startUrl}</span>
                    </div>
                    <div className="flex justify-between gap-6 border-t pt-2">
                      <span className="uppercase tracking-widest text-muted-foreground">output</span>
                      <span>1280×720 MP4 · captions</span>
                    </div>
                  </PlanContent>
                  <PlanFooter>
                    <Button
                      className="w-full"
                      disabled={busy}
                      onClick={() => submit("Looks good — start recording now.")}
                    >
                      <VideoIcon /> {busy ? "rolling…" : "roll camera"}
                    </Button>
                  </PlanFooter>
                </Plan>
              </div>
            )}

            {stage.mode === "login" && (
              <Fragment>
                <div className="flex items-center justify-between gap-4 border-b bg-amber/10 px-4 py-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    <b className="text-muted-foreground">private set</b> · log in to {stage.domain} yourself —
                    nothing is being recorded
                  </span>
                  <Button size="sm" onClick={() => void confirmLogin()}>
                    <LockKeyholeOpenIcon /> i&apos;m logged in — continue
                  </Button>
                </div>
                <WebPreview className="w-full border-0" defaultUrl={stage.liveViewUrl}>
                  <WebPreviewNavigation>
                    {/* decorative macOS traffic lights */}
                    <span aria-hidden className="flex items-center gap-1.5 pl-1.5 pr-2">
                      <span className="size-3 rounded-full bg-[#ff5f57]" />
                      <span className="size-3 rounded-full bg-[#febc2e]" />
                      <span className="size-3 rounded-full bg-[#28c840]" />
                    </span>
                    <WebPreviewUrl readOnly />
                  </WebPreviewNavigation>
                  <WebPreviewBody className="aspect-[1280/800] w-full flex-none" allow="clipboard-read; clipboard-write" />
                </WebPreview>
              </Fragment>
            )}

            {stage.mode === "live" && (
              <Fragment>
                {/* Unmounted while composing — a translucent overlay left the
                    live browser visibly moving underneath the film screen. */}
                {stage.composing ? null : stage.liveViewUrl ? (
                  <WebPreview className="w-full border-0" defaultUrl={stage.liveViewUrl}>
                    <WebPreviewNavigation>
                      {/* decorative macOS traffic lights */}
                      <span aria-hidden className="flex items-center gap-1.5 pl-1.5 pr-2">
                        <span className="size-3 rounded-full bg-[#ff5f57]" />
                        <span className="size-3 rounded-full bg-[#febc2e]" />
                        <span className="size-3 rounded-full bg-[#28c840]" />
                      </span>
                      <WebPreviewUrl readOnly />
                    </WebPreviewNavigation>
                    {/* Kernel viewport is 1280×800 — matching the ratio kills the letterbox */}
                    <WebPreviewBody className="aspect-[1280/800] w-full flex-none" allow="clipboard-read; clipboard-write" />
                  </WebPreview>
                ) : (
                  <div className="flex aspect-[1280/800] w-full items-center justify-center">
                    <Shimmer className="font-mono text-xs uppercase tracking-[0.3em]">
                      — opening camera —
                    </Shimmer>
                  </div>
                )}

                {!stage.composing && ticks.length > 0 && (
                  <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 border-t bg-background/85 p-3 font-mono text-xs backdrop-blur">
                    {ticks.map((t, i) => (
                      <div
                        key={`${t.n}-${i}`}
                        className={cn(
                          "flex items-center gap-3",
                          i < ticks.length - 1 && "opacity-40",
                        )}
                      >
                        <span className="text-muted-foreground">{String(t.n).padStart(2, "0")}</span>
                        <span className="uppercase tracking-widest text-muted-foreground">{t.action}</span>
                        <span className="flex-1 truncate">{t.caption}</span>
                        <span className={t.ok ? "text-ok" : "text-rec"}>{t.ok ? "✓" : "✗"}</span>
                      </div>
                    ))}
                  </div>
                )}

                {stage.composing && (
                  <div className="flex aspect-[1280/800] w-full flex-col items-center justify-center gap-6 bg-background">
                    <LoopaLoader className="h-10 text-muted-foreground" />
                    <Shimmer className="font-mono text-xs uppercase tracking-[0.3em]">
                      developing film
                    </Shimmer>
                    <div className="flex w-64 flex-col gap-2 font-mono text-[11px]">
                      {COMPOSE_STAGES.map((s) => {
                        const idx = COMPOSE_STAGES.indexOf(compose?.stage ?? "");
                        const mine = COMPOSE_STAGES.indexOf(s);
                        const state = idx < 0 ? "pending" : mine < idx ? "done" : mine === idx ? "active" : "pending";
                        return (
                          <div key={s} className="flex flex-col gap-1.5">
                            <div
                              className={cn(
                                "flex items-center gap-2.5 uppercase tracking-widest transition-colors",
                                state === "done" && "text-muted-foreground",
                                state === "active" && "text-foreground",
                                state === "pending" && "text-muted-foreground/40",
                              )}
                            >
                              <span className={cn("w-3 text-center", state === "done" && "text-ok")}>
                                {state === "done" ? "✓" : state === "active" ? "●" : "·"}
                              </span>
                              <span className={cn(state === "active" && "animate-pulse")}>{s}</span>
                              {state === "active" && compose?.pct != null && (
                                <span className="ml-auto tabular-nums text-muted-foreground">
                                  {Math.round(compose.pct * 100)}%
                                </span>
                              )}
                            </div>
                            {state === "active" && compose?.pct != null && (
                              <div className="ml-5.5 h-1 overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-rec transition-[width] duration-500"
                                  style={{ width: `${Math.round(compose.pct * 100)}%` }}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <p className="max-w-xs text-center text-xs text-muted-foreground">
                      Your take is safe — the cut lands here and in your library when it&apos;s done.
                    </p>
                  </div>
                )}
              </Fragment>
            )}

            {stage.mode === "done" && (
              <Fragment>
                <DemoPlayer className="rounded-none border-0" src={stage.videoUrl} chapters={stage.chapters} />
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    <b className="text-ok">wrap ✓</b> · {stage.durationSec.toFixed(1)}s · 1280×720 ·
                    h264
                  </span>
                  <span className="flex gap-2">
                    <Button asChild size="sm">
                      <Link href={`/videos/${stage.jobId}`} target="_blank">
                        <SquareArrowOutUpRightIcon /> open video
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline" title="Download MP4">
                      <a href={`${stage.videoUrl}?download`}>
                        <DownloadIcon />
                      </a>
                    </Button>
                    <Button size="sm" variant="outline" title="New take" onClick={() => setStage({ mode: "idle" })}>
                      <RotateCcwIcon />
                    </Button>
                  </span>
                </div>
              </Fragment>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
