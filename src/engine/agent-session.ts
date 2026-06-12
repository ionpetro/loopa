import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Agent, type SDKAgent } from "@cursor/sdk";
import { BrowserSession, observationText } from "./browser-session.ts";
import { composeVideo } from "./compose.ts";
import { createJob, jobDir } from "./jobs.ts";
import type {
  BrowserAction, DemoJob, DemoParams, Observation, Recipe, RecipeStep, SessionEvent, TimedCaption,
} from "./types.ts";

const MAX_ACTIONS = 24;
const OUTPUT = { fps: 30, width: 1280, height: 720, quality: 60 };

const SYSTEM = `You are a video walkthrough producer. You plan browser demo videos with the user, then record them by driving a real cloud browser yourself.

## Phase 1 — plan (chat)
Collect two things:
1. **Goal** — what the video should demonstrate.
2. **Start URL** — full https:// URL of the first page.

Rules:
- Ask one or two short questions at a time. Don't repeat answered questions.
- When you have BOTH, call set_demo_params, then summarize the plan and ask the user to confirm.
- Public pages only — never log in, sign up, pay, or change data.

## Phase 2 — record (after the user confirms)
Call start_demo. It opens a recorded cloud browser at the start URL and returns the page observation (URL, ELEMENTS list with indexes, screenshot). The user is watching live, and EVERYTHING you do is being recorded into the final video — move deliberately, shortest clean path, no backtracking.

Then repeat: call browser_action with exactly ONE action (click/type/hover/scroll/goto/wait) toward the goal. For click/type/hover set target_index from the LATEST elements list. Always include a short viewer-facing "caption" — it's overlaid on the video while that action plays. Each call returns a fresh elements list; do not call observe_page unless the list seems stale or you need to see the page.

When the goal is visibly achieved, call finish_demo with a short video title. It stops recording, produces the MP4, and returns the result. Tell the user it's ready and ask if they want another take or a different demo.

If a recording fails, apologize briefly and ask whether to retry or adjust the plan.`;

interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

/** Convert a live action into a replayable recipe step (same schema as feature-video-agent). */
function stepFromAction(a: BrowserAction, obs: Observation | null): RecipeStep {
  const cap = a.caption || undefined;
  if (a.action === "goto") return { action: "goto", url: a.url, caption: cap, waitAfter: 600 };
  if (a.action === "scroll") return { action: "scroll", dy: a.dy ?? 320, caption: cap, waitAfter: 600 };
  if (a.action === "wait") return { action: "wait", ms: a.ms ?? 800 };
  const el = obs?.elements[a.targetIndex ?? -1];
  let target: Partial<RecipeStep>;
  if (el?.selText) target = { text: el.selText };
  else if (el?.name && el.tag === "a") target = { role: "link", name: el.name };
  else if (el?.name && (el.tag === "button" || el.role === "button")) target = { role: "button", name: el.name };
  else if (el?.sel && el.sel.length < 80) target = { selector: el.sel };
  else if (el?.name) target = { text: el.name };
  else target = { selector: el?.sel ?? "body" };
  const step: RecipeStep = { action: a.action, caption: cap, waitAfter: a.action === "type" ? 600 : 500, ...target };
  if (el?.dialog) step.dialog = true;
  if (a.action === "type") { step.text = a.text ?? ""; step.delay = 150; }
  return step;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "demo";

export class AgentSession {
  readonly id: string;
  private agent: SDKAgent | null = null;
  private emitter = new EventEmitter();
  private buffer: SessionEvent[] = [];
  private busy = false;

  private params: DemoParams | null = null;
  private job: DemoJob | null = null;
  private browser: BrowserSession | null = null;
  private lastObs: Observation | null = null;
  private actionCount = 0;
  private captions: TimedCaption[] = [];
  private steps: RecipeStep[] = [];

  constructor(id: string) {
    this.id = id;
  }

  // --- events -------------------------------------------------------------

  private emit(ev: SessionEvent) {
    this.buffer.push(ev);
    if (this.buffer.length > 500) this.buffer.shift();
    this.emitter.emit("event", ev);
  }

  subscribe(onEvent: (ev: SessionEvent) => void): () => void {
    for (const ev of this.buffer) onEvent(ev);
    this.emitter.on("event", onEvent);
    return () => this.emitter.off("event", onEvent);
  }

  // --- chat ---------------------------------------------------------------

  private async ensureAgent(): Promise<SDKAgent> {
    if (this.agent) return this.agent;
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) throw new Error("CURSOR_API_KEY is not set");
    this.agent = await Agent.create({
      apiKey,
      model: { id: "composer-2.5" },
      local: { cwd: process.cwd(), customTools: this.buildTools() },
    });
    return this.agent;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async handleMessage(message: string): Promise<void> {
    if (this.busy) {
      this.emit({ type: "error", message: "Agent is busy — wait for the current turn to finish." });
      return;
    }
    this.busy = true;
    try {
      const agent = await this.ensureAgent();
      const isFirst = this.buffer.length === 0;
      const prompt = isFirst ? `${SYSTEM}\n\nUser: ${message}` : message;
      const run = await agent.send(prompt);
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) this.emit({ type: "agent_text", text: block.text });
          }
        } else if (event.type === "tool_call" && event.status === "running") {
          this.emit({ type: "tool_call", name: event.name });
        }
      }
      const result = await run.wait();
      if (result.status === "error") this.emit({ type: "error", message: "Agent run failed." });
    } catch (err) {
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
      // If a recording was left open (agent errored mid-demo), tear it down.
      if (this.browser && this.job?.status === "recording") {
        await this.failJob("agent turn ended without finishing the demo");
      }
      this.emit({ type: "agent_turn_done" });
    }
  }

  // --- demo lifecycle (invoked by agent tools) ------------------------------

  private async failJob(reason: string) {
    if (this.job) {
      this.job.status = "error";
      this.job.error = reason;
      this.emit({ type: "job_status", jobId: this.job.id, status: "error" });
    }
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.job = null;
  }

  private buildTools() {
    return {
      set_demo_params: {
        description: "Save the confirmed demo goal and start URL. Call once when both are known, before asking the user to confirm.",
        inputSchema: {
          type: "object",
          properties: { goal: { type: "string" }, startUrl: { type: "string" } },
          required: ["goal", "startUrl"],
        },
        execute: async (args: any): Promise<ToolResult> => {
          this.params = { goal: String(args.goal), startUrl: String(args.startUrl) };
          this.emit({ type: "plan", goal: this.params.goal, startUrl: this.params.startUrl });
          return text(JSON.stringify({ saved: true, ...this.params, next: "Ask the user to confirm, then call start_demo." }));
        },
      },

      start_demo: {
        description: "Open a recorded cloud browser at the start URL and begin the demo. Returns the initial page observation. Only call after the user confirmed the plan.",
        inputSchema: { type: "object", properties: {} },
        execute: async (): Promise<ToolResult> => {
          if (!this.params) return { ...text("No demo params saved — call set_demo_params first."), isError: true };
          if (this.browser) return { ...text("A demo is already in progress."), isError: true };
          try {
            this.job = createJob(this.params.goal, this.params.startUrl);
            this.actionCount = 0;
            this.captions = [];
            this.steps = [{ action: "goto", url: this.params.startUrl, caption: "Open the page", waitAfter: 600 }];
            this.emit({ type: "job_created", jobId: this.job.id, goal: this.job.goal, startUrl: this.job.startUrl });

            const framesDir = path.join(jobDir(this.job.id), "frames");
            this.browser = await BrowserSession.create(framesDir);
            this.job.liveViewUrl = this.browser.liveViewUrl;
            if (this.browser.liveViewUrl) {
              this.emit({ type: "live_view", jobId: this.job.id, url: this.browser.liveViewUrl });
            }

            await this.browser.startRecording({ width: OUTPUT.width, height: OUTPUT.height, quality: OUTPUT.quality });
            this.captions.push({ t: 0, text: "Open the page" });
            const nav = await this.browser.act({ action: "goto", url: this.params.startUrl });
            if (!nav.ok) throw new Error(`could not open ${this.params.startUrl}: ${nav.error}`);
            this.lastObs = await this.browser.observe();
            this.emit({ type: "action", jobId: this.job.id, n: 0, action: "goto", caption: "Open the page", ok: true });

            return {
              content: [
                { type: "text", text: `Recording started. The user is watching live.\n\n${observationText(this.lastObs)}` },
                { type: "image", data: this.lastObs.shot!, mimeType: "image/jpeg" },
              ],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.failJob(msg);
            return { ...text(`start_demo failed: ${msg}`), isError: true };
          }
        },
      },

      browser_action: {
        description: "Perform exactly ONE recorded browser action toward the goal. For click/type/hover, set target_index from the latest ELEMENTS list. Include a short viewer-facing caption.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["goto", "click", "type", "hover", "scroll", "wait"] },
            target_index: { type: "integer" },
            url: { type: "string" },
            text: { type: "string" },
            dy: { type: "integer" },
            ms: { type: "integer" },
            caption: { type: "string" },
          },
          required: ["action"],
        },
        execute: async (args: any): Promise<ToolResult> => {
          if (!this.browser || !this.job) return { ...text("No demo in progress — call start_demo first."), isError: true };
          if (this.actionCount >= MAX_ACTIONS) {
            return { ...text(`Max ${MAX_ACTIONS} actions reached — call finish_demo now.`), isError: true };
          }
          this.actionCount++;

          const a: BrowserAction = {
            action: args.action,
            targetIndex: args.target_index != null ? Number(args.target_index) : undefined,
            url: args.url != null ? String(args.url) : undefined,
            text: args.text != null ? String(args.text) : undefined,
            dy: args.dy != null ? Number(args.dy) : undefined,
            ms: args.ms != null ? Number(args.ms) : undefined,
            caption: args.caption != null ? String(args.caption) : "",
          };

          if (a.caption) this.captions.push({ t: this.browser.now(), text: a.caption });
          const obsBefore = this.lastObs;
          const result = await this.browser.act(a);
          this.steps.push(stepFromAction(a, obsBefore));
          this.lastObs = await this.browser.observe(false);

          this.job.actions.push({ n: this.actionCount, action: a.action, caption: a.caption ?? "", ok: result.ok, error: result.error });
          this.emit({
            type: "action", jobId: this.job.id, n: this.actionCount,
            action: a.action, caption: a.caption ?? "", ok: result.ok, error: result.error,
          });

          return text(JSON.stringify({
            ok: result.ok,
            error: result.error,
            url: result.url,
            actionsUsed: `${this.actionCount}/${MAX_ACTIONS}`,
            observation: observationText(this.lastObs),
          }));
        },
      },

      observe_page: {
        description: "Re-observe the current page (elements list + screenshot). Only needed if the latest list is stale.",
        inputSchema: { type: "object", properties: {} },
        execute: async (): Promise<ToolResult> => {
          if (!this.browser) return { ...text("No demo in progress."), isError: true };
          this.lastObs = await this.browser.observe();
          return {
            content: [
              { type: "text", text: observationText(this.lastObs) },
              { type: "image", data: this.lastObs.shot!, mimeType: "image/jpeg" },
            ],
          };
        },
      },

      finish_demo: {
        description: "Stop recording and produce the final MP4. Call when the goal is visibly achieved.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string", description: "Short video title" } },
          required: ["title"],
        },
        execute: async (args: any): Promise<ToolResult> => {
          if (!this.browser || !this.job || !this.params) {
            return { ...text("No demo in progress."), isError: true };
          }
          const job = this.job;
          const browser = this.browser;
          try {
            job.status = "composing";
            this.emit({ type: "job_status", jobId: job.id, status: "composing" });

            const frames = await browser.stopRecording();
            const title = String(args.title || this.params.goal);
            const host = new URL(this.params.startUrl).host;
            const overlays = await browser.renderOverlays({
              W: OUTPUT.width, H: OUTPUT.height,
              captions: this.captions.map((c) => c.text),
              brand: host.replace(/^www\./, "").toUpperCase(),
              title,
              subtitle: "DEMO STUDIO · Walkthrough",
              outro: host,
            });
            await browser.close();
            this.browser = null;

            const out = composeVideo({
              frames, captions: this.captions, overlays,
              outDir: jobDir(job.id), width: OUTPUT.width, height: OUTPUT.height, fps: OUTPUT.fps,
            });

            const recipe: Recipe = {
              name: `auto-${slug(this.params.goal)}`,
              title,
              subtitle: "DEMO STUDIO · Walkthrough",
              brand: host.replace(/^www\./, "").toUpperCase(),
              outro: host,
              goal: this.params.goal,
              output: OUTPUT,
              steps: this.steps,
            };
            fs.writeFileSync(path.join(jobDir(job.id), "recipe.json"), JSON.stringify(recipe, null, 2));
            fs.writeFileSync(path.join(jobDir(job.id), "report.json"), JSON.stringify({
              job: job.id, goal: job.goal, actions: job.actions,
              frames: out.frameCount, durationSec: out.durationSec,
            }, null, 2));
            fs.rmSync(path.join(jobDir(job.id), "frames"), { recursive: true, force: true });

            job.status = "done";
            job.videoPath = out.finalPath;
            job.durationSec = out.durationSec;
            this.emit({ type: "job_status", jobId: job.id, status: "done" });
            this.emit({ type: "video_ready", jobId: job.id, videoUrl: `/api/jobs/${job.id}/video`, durationSec: out.durationSec });

            this.job = null;
            this.params = null;
            this.lastObs = null;
            return text(JSON.stringify({ ok: true, video: out.finalPath, durationSec: out.durationSec, frames: out.frameCount }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.failJob(msg);
            return { ...text(`finish_demo failed: ${msg}`), isError: true };
          }
        },
      },
    };
  }

  async dispose(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    try {
      await this.agent?.[Symbol.asyncDispose]?.();
    } catch {}
    this.agent = null;
  }
}

// Session registry, HMR-safe.
const sessions: Map<string, AgentSession> = ((globalThis as any).__demoSessions ??= new Map());

export function createSession(): AgentSession {
  const id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const s = new AgentSession(id);
  sessions.set(id, s);
  return s;
}

export function getSession(id: string): AgentSession | undefined {
  return sessions.get(id);
}
