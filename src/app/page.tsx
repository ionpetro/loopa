"use client";

import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { CheckIcon, ClapperboardIcon, CopyIcon, DownloadIcon, FilmIcon, RotateCcwIcon, SquareArrowOutUpRightIcon, VideoIcon } from "lucide-react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
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
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { WebPreview, WebPreviewBody, WebPreviewNavigation, WebPreviewUrl } from "@/components/ai-elements/web-preview";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useDemoSession, type ChatMessage } from "@/hooks/use-demo-session";
import { apiBase } from "@/lib/api-base";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "Demo the GamerPlug referral leaderboard",
  "Walk through gamerplug.app tournaments",
  "Show searching Hacker News for 'AI agents'",
];

function fmtTimecode(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  const ff = String(Math.floor((ms % 1000) / 40)).padStart(2, "0");
  return `${mm}:${ss}:${ff}`;
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
      {copied ? "copied" : "copy agent instructions"}
    </Button>
  );
}

function ChatMessageView({ message }: { message: ChatMessage }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) =>
          part.type === "text" ? (
            <MessageResponse key={i}>{part.text}</MessageResponse>
          ) : (
            <div
              key={part.toolCallId}
              className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70"
            >
              <span className="text-ok">✓</span>
              <span>{part.toolName.replaceAll("_", " ")}</span>
            </div>
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
  const { messages, busy, stage, setStage, ticks, compose, error, recStart, send, model, setModel } = useDemoSession();
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

  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput("");
    void send(text).catch(() => {});
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── producer rail ───────────────────────────────────────────── */}
      <aside className="flex w-105 shrink-0 flex-col border-r bg-background">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-5">
          <div className="font-display text-xl tracking-tight">
            demo<span className="text-rec">·</span>studio
          </div>
          <div className="flex items-center gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              producer line
            </div>
            <ThemeToggle />
            <Show when="signed-out">
              <SignInButton>
                <Button size="sm" variant="outline">sign in</Button>
              </SignInButton>
              <SignUpButton>
                <Button size="sm">sign up</Button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">
              <Link
                href="/videos"
                title="My videos"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <FilmIcon className="size-4" />
              </Link>
              <UserButton />
            </Show>
          </div>
        </header>

        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="gap-5 px-4 py-5">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<ClapperboardIcon className="size-7" />}
                title="Direct it. I'll shoot it."
                description="Tell me what you want recorded — a feature, a flow, a page. I'll plan the shot list with you, drive a live browser while you watch, and hand you the MP4."
              />
            ) : (
              messages.map((m) => <ChatMessageView key={m.id} message={m} />)
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

        <div className="flex flex-col gap-3 border-t p-4">
          {messages.length === 0 && (
            <Suggestions>
              {SUGGESTIONS.map((s) => (
                <Suggestion key={s} suggestion={s} onClick={submit} />
              ))}
            </Suggestions>
          )}
          <PromptInput onSubmit={({ text }) => submit(text)}>
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

      {/* ── stage ───────────────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col bg-bg-deep">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <span className={cn("flex items-center gap-2", recording && "text-rec")}>
            <span className={cn("size-2 rounded-full bg-current", recording && "rec-dot")} />
            {recording ? "rec" : stage.mode === "done" ? "wrap" : "standby"}
          </span>
          <span>cam·01 / kernel cloud</span>
          <span className="tabular-nums">{fmtTimecode(recording ? clock : 0)}</span>
        </div>

        <div className="relative min-h-0 flex-1 p-6">
          <div
            className={cn(
              "relative flex h-full flex-col overflow-hidden rounded-xl border bg-background shadow-[0_0_80px_-20px_oklch(0_0_0/60%)]",
              recording && "border-rec/50 ring-1 ring-rec/30",
            )}
          >
            {stage.mode === "idle" && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  — standby —
                </div>
                <h1 className="font-display text-5xl leading-tight tracking-tight">
                  Direct it.
                  <br />
                  I&apos;ll shoot it.
                </h1>
                <p className="max-w-md text-sm text-muted-foreground">
                  An agent plans your browser demo with you, drives a real cloud browser on camera,
                  and delivers a captioned MP4.
                </p>
                <div className="mt-2 flex flex-col items-center gap-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
                    or let your own agent direct
                  </div>
                  <CopyAgentInstructions />
                </div>
              </div>
            )}

            {stage.mode === "plan" && (
              <div className="flex flex-1 items-center justify-center p-10">
                <Plan defaultOpen className="w-full max-w-xl">
                  <PlanHeader>
                    <div className="flex flex-col gap-1.5">
                      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber">
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

            {stage.mode === "live" && (
              <Fragment>
                {stage.liveViewUrl ? (
                  <WebPreview className="flex-1 border-0" defaultUrl={stage.liveViewUrl}>
                    <WebPreviewNavigation>
                      <WebPreviewUrl readOnly />
                    </WebPreviewNavigation>
                    <WebPreviewBody allow="clipboard-read; clipboard-write" />
                  </WebPreview>
                ) : (
                  <div className="flex flex-1 items-center justify-center">
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
                        <span className="uppercase tracking-widest text-amber">{t.action}</span>
                        <span className="flex-1 truncate">{t.caption}</span>
                        <span className={t.ok ? "text-ok" : "text-rec"}>{t.ok ? "✓" : "✗"}</span>
                      </div>
                    ))}
                  </div>
                )}

                {stage.composing && (
                  <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-background/90 backdrop-blur">
                    <div className="spool" />
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
                                <span className="ml-auto tabular-nums text-amber">
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
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video className="min-h-0 flex-1 bg-black object-contain" src={stage.videoUrl} controls autoPlay />
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    <b className="text-ok">wrap ✓</b> · {stage.durationSec.toFixed(1)}s · 1280×720 ·
                    h264
                  </span>
                  <span className="flex gap-2">
                    <Button asChild size="sm">
                      <Link href={`/videos/${stage.jobId}`} target="_blank">
                        <SquareArrowOutUpRightIcon /> watch page
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href={`${stage.videoUrl}?download`}>
                        <DownloadIcon /> download mp4
                      </a>
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setStage({ mode: "idle" })}>
                      <RotateCcwIcon /> new take
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
