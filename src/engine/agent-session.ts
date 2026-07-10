import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Agent, type SDKAgent } from "@cursor/sdk";
import { BrowserSession, observationText } from "./browser-session.ts";
import { getLocalAgentStore } from "./sdk-store.ts";
import { composeVideo } from "./compose.ts";
import { createJob, jobDir, DATA_DIR } from "./jobs.ts";
import { ensureKernelProfile, kernelProfileExists, profileNameFor } from "./kernel.ts";
import { flushDb, persistJob, persistMessage, persistSession } from "./db.ts";
import { clip, log, since } from "./log.ts";
import { uploadThumbnail, uploadVideo } from "./storage.ts";
import { assertRunQuota } from "./quota.ts";
import { apiUrl } from "../lib/api-base.ts";
import type {
  BrowserAction, ChatPart, DemoJob, DemoParams, Observation, Recipe, RecipeStep, SessionEvent, TimedCaption,
} from "./types.ts";

const MAX_ACTIONS = 24;
const OUTPUT = { fps: 30, width: 1280, height: 720, quality: 60 };
/** How long a login handoff waits for the user before giving up. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const SYSTEM = `You are a video walkthrough producer. You plan browser demo videos with the user, then record them by driving a real cloud browser yourself.

## Phase 1 — plan (chat)
Collect two things:
1. **Goal** — what the video should demonstrate.
2. **Start URL** — the first page to open.

Rules:
- Infer the start URL from a casual site name ("go on google" → https://www.google.com) instead of asking for the full https:// URL. If the domain is ambiguous, suggest one and proceed once the user agrees.
- Ask one or two short questions at a time. Don't repeat answered questions.
- When you have BOTH, call set_demo_params, then summarize the plan and ask the user to confirm.
- If the demo needs the user's account (they say the page is behind a login, or the goal clearly requires being signed in), call request_login after set_demo_params and BEFORE start_demo. It opens a private, un-recorded browser where the user logs in themselves; their session is saved for this and future demos on that site.
- NEVER ask for, accept, or type credentials (usernames, passwords, 2FA codes). If the user pastes credentials into chat, do not use or repeat them — point them to the secure login window instead.

## Phase 2 — record (after the user confirms)
Call start_demo. It opens a recorded cloud browser at the start URL and returns the page observation (URL, ELEMENTS list with indexes, screenshot). The user is watching live, and EVERYTHING you do is being recorded into the final video — move deliberately, shortest clean path, no backtracking.

Then repeat: call browser_action with exactly ONE action (click/type/hover/scroll/goto/wait) toward the goal. For click/type/hover set target_index from the LATEST elements list. Always include a short viewer-facing "caption" — it's overlaid on the video while that action plays. Each call returns a fresh elements list; do not call observe_page unless the list seems stale or you need to see the page.

When the goal is visibly achieved, call finish_demo with a short video title. It stops recording, produces the MP4, and returns the result. Tell the user it's ready and ask if they want another take or a different demo.

If a login wall unexpectedly blocks the demo mid-recording, do NOT type credentials — call abort_demo, then offer to set up the login (request_login) and re-record.

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
  private hasStarted = false;
  private busy = false;
  private userId: string | undefined;
  private turnParts: ChatPart[] | null = null;
  /** When the current job's cloud browser came up (usage accounting). */
  private jobStartedAt = 0;
  private model = "composer-2.5";

  private params: DemoParams | null = null;
  private job: DemoJob | null = null;
  private browser: BrowserSession | null = null;
  /** Pending login handoff — resolves true when the user clicks Continue. */
  private loginResolve: ((confirmed: boolean) => void) | null = null;
  private lastObs: Observation | null = null;
  private actionCount = 0;
  private captions: TimedCaption[] = [];
  private steps: RecipeStep[] = [];

  constructor(id: string) {
    this.id = id;
  }

  /** Log tag: the job when one is live (its story matters most), else the session. */
  private get tag(): string {
    return this.job ? `job ${this.job.id}` : `session ${this.id}`;
  }

  // --- events -------------------------------------------------------------

  private emit(ev: SessionEvent) {
    this.emitter.emit("event", ev);
    // Write-through: any job-affecting event snapshots the job's state to the DB.
    if (this.job && (ev.type === "job_created" || ev.type === "action" || ev.type === "job_status" || ev.type === "video_ready")) {
      persistJob(this.job);
    }
  }

  /**
   * Surface a tool call to the client and the persisted transcript. The SDK
   * stream reports every custom tool as just "mcp", so each tool announces
   * itself with a one-word studio label instead.
   */
  private noteToolCall(label: string) {
    log.info(this.tag, `tool: ${label}`);
    this.emit({ type: "tool_call", name: label });
    this.turnParts?.push({ type: "tool-call", toolCallId: `tc-${this.turnParts.length}`, toolName: label });
  }

  /** Associate this session with the authenticated Clerk user (first writer wins). */
  setUser(userId: string | undefined): void {
    if (userId && this.userId !== userId) {
      this.userId = userId;
      persistSession(this.id, userId);
    }
  }

  subscribe(onEvent: (ev: SessionEvent) => void): () => void {
    // Each message opens its own SSE stream; only forward live events for this
    // turn. The client keeps its own chat history, so replaying past events here
    // would re-append every prior turn's text onto the new reply.
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
      model: { id: this.model },
      local: { cwd: process.cwd(), customTools: this.buildTools(), store: getLocalAgentStore() },
    });
    return this.agent;
  }

  /**
   * Switch the Cursor model. The agent is recreated on the next turn (a model
   * can't change mid-agent), so its internal context resets and the system
   * prompt is re-sent; the client keeps its own chat history.
   */
  setModel(modelId: string): void {
    if (!modelId || modelId === this.model) return;
    this.model = modelId;
    const old = this.agent;
    this.agent = null;
    this.hasStarted = false;
    if (old) {
      Promise.resolve(old[Symbol.asyncDispose]?.()).catch(() => {});
    }
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Resolve a pending login handoff (the UI's Continue button). False when none is open. */
  confirmLogin(): boolean {
    const resolve = this.loginResolve;
    if (!resolve) return false;
    this.loginResolve = null;
    resolve(true);
    return true;
  }

  get hasActiveJob(): boolean {
    return this.job != null;
  }

  async handleMessage(message: string): Promise<void> {
    if (this.busy) {
      this.emit({ type: "error", message: "Agent is busy — wait for the current turn to finish." });
      return;
    }
    this.busy = true;
    const turnStartedAt = Date.now();
    log.info(`session ${this.id}`, `turn start (model ${this.model}, user ${this.userId ?? "anon"}): "${clip(message)}"`);
    const assistantParts: ChatPart[] = [];
    this.turnParts = assistantParts;
    persistSession(this.id, this.userId);
    persistMessage(this.id, "user", [{ type: "text", text: message }]);
    try {
      const agent = await this.ensureAgent();
      const isFirst = !this.hasStarted;
      this.hasStarted = true;
      const prompt = isFirst ? `${SYSTEM}\n\nUser: ${message}` : message;
      const run = await agent.send(prompt);
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              this.emit({ type: "agent_text", text: block.text });
              const tail = assistantParts[assistantParts.length - 1];
              if (tail?.type === "text") tail.text += block.text;
              else assistantParts.push({ type: "text", text: block.text });
            }
          }
        } else if (event.type === "tool_call" && event.status === "running" && event.name !== "mcp") {
          // Custom ("mcp") tools announce themselves via noteToolCall with a
          // real label; only surface non-custom tools from the stream.
          this.emit({ type: "tool_call", name: event.name });
          assistantParts.push({
            type: "tool-call",
            toolCallId: `tc-${assistantParts.length}`,
            toolName: event.name,
          });
        }
      }
      const result = await run.wait();
      if (result.status === "error") {
        log.error(`session ${this.id}`, `agent run failed: ${JSON.stringify(result)}`);
        const detail = (result as any).error?.message ?? (result as any).error ?? (result as any).message;
        this.emit({ type: "error", message: `Agent run failed${detail ? `: ${detail}` : "."}` });
        // A run that died without streaming anything is the "sick process"
        // signature — see noteInstantAgentFailure.
        if (assistantParts.length === 0 && noteInstantAgentFailure()) {
          this.emit({ type: "error", message: "The studio is restarting itself to recover — try again in ~30 seconds." });
        }
      }
    } catch (err) {
      log.error(`session ${this.id}`, "turn crashed", err);
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
      // If a recording was left open (agent errored mid-demo), tear it down.
      if (this.browser && this.job?.status === "recording") {
        await this.failJob("agent turn ended without finishing the demo");
      }
      this.turnParts = null;
      if (assistantParts.length > 0) persistMessage(this.id, "assistant", assistantParts);
      log.info(`session ${this.id}`, `turn done in ${since(turnStartedAt)}`);
      this.emit({ type: "agent_turn_done" });
    }
  }

  // --- demo lifecycle (invoked by agent tools) ------------------------------

  private async failJob(reason: string) {
    if (this.job) {
      log.warn(`job ${this.job.id}`, `failed after ${this.job.actions.length} action(s): ${reason}`);
      this.job.status = "error";
      this.job.error = reason;
      this.emit({ type: "job_status", jobId: this.job.id, status: "error", error: reason });
      // A failed take can leave hundreds of MB of screencast frames behind.
      // The success path already removes these; do the same on failure so a
      // run of stalls doesn't exhaust the disk on the recording box.
      try {
        fs.rmSync(path.join(jobDir(this.job.id), "frames"), { recursive: true, force: true });
      } catch {}
    }
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.job = null;
  }

  /** Saved-login profile for this user + site, if one exists (loaded read-only). */
  private async loginProfileFor(startUrl: string): Promise<{ name: string } | undefined> {
    if (!this.userId) return undefined;
    try {
      const name = profileNameFor(this.userId, new URL(startUrl).host);
      return (await kernelProfileExists(name)) ? { name } : undefined;
    } catch (err) {
      // A profile lookup must never block a recording — run logged out instead.
      log.error(`session ${this.id}`, "profile lookup failed", err instanceof Error ? err.message : err);
      return undefined;
    }
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
          this.noteToolCall("plan");
          this.params = { goal: String(args.goal), startUrl: String(args.startUrl) };
          this.emit({ type: "plan", goal: this.params.goal, startUrl: this.params.startUrl });
          return text(JSON.stringify({ saved: true, ...this.params, next: "Ask the user to confirm, then call start_demo." }));
        },
      },

      request_login: {
        description:
          "Open the demo site in a private, UN-recorded cloud browser and hand control to the user so they log in themselves. Blocks until they confirm (or 10 minutes pass); their session is saved for this and future demos on the site. Call after set_demo_params and before start_demo when the demo needs their account. Never ask the user for credentials.",
        inputSchema: {
          type: "object",
          properties: { login_url: { type: "string", description: "Page to open for the login; defaults to the start URL." } },
        },
        execute: async (args: any): Promise<ToolResult> => {
          this.noteToolCall("login");
          if (!this.params) return { ...text("No demo params saved — call set_demo_params first."), isError: true };
          if (this.job) return { ...text("A demo is already recording — logins must happen before start_demo."), isError: true };
          if (this.loginResolve) return { ...text("A login handoff is already open."), isError: true };
          const host = new URL(this.params.startUrl).host;
          let profileSaved = false;
          try {
            if (!this.browser) {
              // The user's login should outlive this browser: save_changes
              // persists cookies/localStorage into the per-(user, site) profile
              // on close. Best-effort — profiles are a paid Kernel feature
              // (403 insufficient_plan on the free tier), and the handoff still
              // works without one: the login lives as long as this browser,
              // which start_demo reuses for the recording.
              let profile: { name: string; saveChanges: boolean } | undefined;
              if (this.userId) {
                try {
                  const name = profileNameFor(this.userId, host);
                  await ensureKernelProfile(name);
                  profile = { name, saveChanges: true };
                  profileSaved = true;
                } catch (err) {
                  log.warn(
                    `session ${this.id}`,
                    `profile unavailable — login won't be remembered: ${err instanceof Error ? err.message : err}`,
                  );
                }
              }
              // Real frames dir arrives at start_demo (no job exists yet).
              this.browser = await BrowserSession.create(
                path.join(DATA_DIR, "handoff", this.id, "frames"),
                undefined,
                profile,
              );
              this.jobStartedAt = Date.now();
              const loginUrl = args.login_url ? String(args.login_url) : this.params.startUrl;
              const nav = await this.browser.act({ action: "goto", url: loginUrl });
              if (!nav.ok) throw new Error(`could not open ${loginUrl}: ${nav.error}`);
            }
            if (!this.browser.liveViewUrl) throw new Error("this browser has no live view for the user to log in with");

            log.info(`session ${this.id}`, `login handoff open for ${host} — waiting up to ${LOGIN_TIMEOUT_MS / 60_000}min for the user`);
            this.emit({ type: "needs_login", url: this.browser.liveViewUrl, domain: host });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const confirmed = await new Promise<boolean>((resolve) => {
              this.loginResolve = resolve;
              timer = setTimeout(() => resolve(false), LOGIN_TIMEOUT_MS);
            });
            clearTimeout(timer);
            this.loginResolve = null;
            log.info(`session ${this.id}`, `login handoff for ${host} ${confirmed ? "confirmed by the user" : "timed out"}`);
            this.emit({ type: "login_done" });

            if (!confirmed) {
              await this.browser?.close().catch(() => {});
              this.browser = null;
              return {
                ...text("The user did not finish logging in within 10 minutes; the login window was closed. Ask whether to try again."),
                isError: true,
              };
            }
            this.lastObs = await this.browser.observe();
            return {
              content: [
                {
                  type: "text",
                  text: `The user finished logging in — the browser stays signed in for the recording${profileSaved ? `, and the session is saved for future demos on ${host}` : ` (this recording only — saved logins are not available on this plan)`}. Nothing was recorded. Current page:\n\n${observationText(this.lastObs)}\n\nConfirm the plan with the user, then call start_demo.`,
                },
                { type: "image", data: this.lastObs.shot!, mimeType: "image/jpeg" },
              ],
            };
          } catch (err) {
            this.loginResolve = null;
            await this.browser?.close().catch(() => {});
            this.browser = null;
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`session ${this.id}`, `request_login failed: ${msg}`);
            return { ...text(`request_login failed: ${msg}`), isError: true };
          }
        },
      },

      start_demo: {
        description: "Open a recorded cloud browser at the start URL and begin the demo. Returns the initial page observation. Only call after the user confirmed the plan.",
        inputSchema: { type: "object", properties: {} },
        execute: async (): Promise<ToolResult> => {
          this.noteToolCall("roll");
          if (!this.params) return { ...text("No demo params saved — call set_demo_params first."), isError: true };
          if (this.browser && this.job) return { ...text("A demo is already in progress."), isError: true };
          try {
            await assertRunQuota(this.userId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ...text(`start_demo blocked: ${msg} Tell the user, do not retry.`), isError: true };
          }
          try {
            this.job = createJob(this.params.goal, this.params.startUrl, {
              userId: this.userId,
              sessionId: this.id,
            });
            this.actionCount = 0;
            this.captions = [];
            this.steps = [{ action: "goto", url: this.params.startUrl, caption: "Open the page", waitAfter: 600 }];
            log.info(`job ${this.job.id}`, `created (session ${this.id}, start ${this.params.startUrl}, goal "${clip(this.params.goal)}")`);
            this.emit({ type: "job_created", jobId: this.job.id, goal: this.job.goal, startUrl: this.job.startUrl });

            const framesDir = path.join(jobDir(this.job.id), "frames");
            if (this.browser) {
              // Login-handoff browser from request_login — it carries the
              // user's signed-in session; just point it at the job's frames.
              this.browser.setFramesDir(framesDir);
            } else {
              // No handoff this time: load the saved login for this site when
              // one exists (read-only — recordings never write the profile).
              this.browser = await BrowserSession.create(framesDir, undefined, await this.loginProfileFor(this.params.startUrl));
              this.jobStartedAt = Date.now();
            }
            this.job.liveViewUrl = this.browser.liveViewUrl;
            if (this.browser.liveViewUrl) {
              this.emit({ type: "live_view", jobId: this.job.id, url: this.browser.liveViewUrl });
            }

            // Navigate BEFORE the screencast starts: the Kernel browser boots on
            // its default page (DuckDuckGo), and recording first meant every
            // video opened with it plus the whole navigation wait.
            const nav = await this.browser.act({ action: "goto", url: this.params.startUrl });
            if (!nav.ok) throw new Error(`could not open ${this.params.startUrl}: ${nav.error}`);
            await this.browser.startRecording({ width: OUTPUT.width, height: OUTPUT.height, quality: OUTPUT.quality });
            log.info(`job ${this.job.id}`, `recording started (live view: ${this.browser.liveViewUrl ?? "none"})`);
            this.captions.push({ t: 0, text: "Open the page" });
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
          this.noteToolCall("action");
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

          const detail = a.action === "goto" ? ` ${a.url}` : a.targetIndex != null ? ` #${a.targetIndex}` : "";
          log.info(
            `job ${this.job.id}`,
            `action ${this.actionCount}/${MAX_ACTIONS} ${a.action}${detail} → ${result.ok ? "ok" : `FAILED: ${result.error}`} @ ${result.url}`,
          );
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
          this.noteToolCall("observe");
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
          this.noteToolCall("wrap");
          if (!this.browser || !this.job || !this.params) {
            return { ...text("No demo in progress."), isError: true };
          }
          const job = this.job;
          const browser = this.browser;
          // Stage-by-stage visibility for the composing overlay and fly logs;
          // events also feed the SSE stream and the headless-run watchdog.
          const stage = (name: string, pct?: number) => {
            log.info(`job ${job.id}`, `compose: ${name}${pct != null ? ` ${(pct * 100).toFixed(0)}%` : ""}`);
            this.emit({ type: "compose_progress", jobId: job.id, stage: name, pct });
          };
          try {
            job.status = "composing";
            this.emit({ type: "job_status", jobId: job.id, status: "composing" });

            stage("processing frames");
            const frames = await browser.stopRecording();
            const title = String(args.title || this.params.goal);
            const host = new URL(this.params.startUrl).host;
            stage("printing captions");
            const overlays = await browser.renderOverlays({
              W: OUTPUT.width, H: OUTPUT.height,
              captions: this.captions.map((c) => c.text),
              brand: host.replace(/^www\./, "").toUpperCase(),
            });
            const browserSec = this.jobStartedAt ? (Date.now() - this.jobStartedAt) / 1000 : undefined;
            await browser.close();
            this.browser = null;

            stage("encoding cut", 0);
            const composeStart = Date.now();
            let lastPct = 0;
            const out = await composeVideo({
              frames, captions: this.captions, overlays, activeWindows: browser.getActionWindows(),
              outDir: jobDir(job.id), width: OUTPUT.width, height: OUTPUT.height, fps: OUTPUT.fps,
              onProgress: (pct) => {
                // Encode is far faster than realtime; only ship meaningful steps.
                if (pct - lastPct >= 0.05 || pct >= 1) {
                  lastPct = pct;
                  stage("encoding cut", pct);
                }
              },
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

            // Durable copy in Supabase Storage when configured; local disk stays the fallback.
            stage("uploading to storage");
            job.videoUrl = await uploadVideo(job.id, out.finalPath);
            // Best-effort: a finished video without a poster frame is still a video.
            job.thumbUrl = await uploadThumbnail(job.id, out.thumbPath).catch((err) => {
              log.error(`job ${job.id}`, "thumbnail upload failed", err instanceof Error ? err.message : err);
              return undefined;
            });

            job.recipe = recipe;
            job.chapters = out.chapters;
            job.usage = {
              model: this.model,
              browserSec: browserSec != null ? +browserSec.toFixed(1) : undefined,
              composeSec: +((Date.now() - composeStart) / 1000).toFixed(1),
              frames: out.frameCount,
              background: out.background ?? undefined,
            };
            job.title = title;
            job.status = "done";
            job.videoPath = out.finalPath;
            job.durationSec = out.durationSec;
            log.info(
              `job ${job.id}`,
              `done — ${out.durationSec.toFixed(1)}s video from ${out.frameCount} frames ` +
                `(browser ${job.usage.browserSec ?? "?"}s, compose ${job.usage.composeSec}s) → ${job.videoUrl ?? out.finalPath}`,
            );
            this.emit({ type: "job_status", jobId: job.id, status: "done" });
            this.emit({
              type: "video_ready",
              jobId: job.id,
              videoUrl: job.videoUrl ?? apiUrl(`/api/jobs/${job.id}/video`),
              durationSec: out.durationSec,
              chapters: out.chapters,
            });

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

      abort_demo: {
        description:
          "Abort the current recording WITHOUT producing a video — e.g. a login wall or broken page blocks the goal. Explain what happened to the user afterwards.",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string", description: "Short reason, shown to the user." } },
          required: ["reason"],
        },
        execute: async (args: any): Promise<ToolResult> => {
          this.noteToolCall("cut");
          if (!this.job) return { ...text("No demo in progress."), isError: true };
          await this.failJob(String(args.reason ?? "").trim() || "aborted by the agent");
          return text(JSON.stringify({
            aborted: true,
            next: "Tell the user why. If a login was required, offer request_login and a re-record.",
          }));
        },
      },
    };
  }

  async dispose(): Promise<void> {
    // Unblock a request_login turn waiting on the user; it cleans up its browser.
    this.loginResolve?.(false);
    this.loginResolve = null;
    await this.browser?.close().catch(() => {});
    this.browser = null;
    try {
      await this.agent?.[Symbol.asyncDispose]?.();
    } catch {}
    this.agent = null;
  }

  /** Fail any open job and release the browser/agent (used on server shutdown). */
  async abort(reason: string): Promise<void> {
    if (this.job) await this.failJob(reason);
    await this.dispose();
  }
}

// Session registry, HMR-safe.
const sessions: Map<string, AgentSession> = ((globalThis as any).__demoSessions ??= new Map());

/**
 * Self-heal for a failure mode observed twice in prod: after hours of uptime,
 * every Cursor run — including on freshly created agents — fails within ~1s
 * with no output, and only a process restart clears it. After two such
 * instant failures inside 5 minutes, exit non-zero (Fly's restart policy
 * brings the machine back in seconds) — but never while a recording is live.
 * Returns true when a restart has been scheduled.
 */
const instantFailures: number[] = [];
function noteInstantAgentFailure(): boolean {
  // Only self-restart where a supervisor restarts us (Fly) — never kill a
  // local Next.js dev server that happens to import this module.
  if (!process.env.FLY_APP_NAME) return false;
  const now = Date.now();
  while (instantFailures.length && now - instantFailures[0] > 5 * 60_000) instantFailures.shift();
  instantFailures.push(now);
  if (instantFailures.length < 2) return false;
  if ([...sessions.values()].some((s) => s.hasActiveJob)) return false;
  log.error("health", "repeated instant agent-run failures with no active jobs — exiting for a clean restart");
  setTimeout(async () => {
    try {
      await flushDb();
    } finally {
      process.exit(1);
    }
  }, 1_000);
  return true;
}

export function createSession(): AgentSession {
  const id = `sess-${randomUUID()}`;
  return getOrCreateSession(id);
}

export function getSession(id: string): AgentSession | undefined {
  return sessions.get(id);
}

/** Create on first use so a client-chosen id can stay on one serverless instance. */
export function getOrCreateSession(id: string): AgentSession {
  let session = sessions.get(id);
  if (!session) {
    session = new AgentSession(id);
    sessions.set(id, session);
  }
  return session;
}

/**
 * Fail every open job and close every cloud browser. Called on shutdown so a
 * deploy marks in-flight recordings as errored (visible to pollers/DB) instead
 * of leaving zombie "recording"/"composing" rows and leaked Kernel sessions.
 */
export async function disposeAllSessions(reason: string): Promise<void> {
  await Promise.allSettled([...sessions.values()].map((s) => s.abort(reason)));
  sessions.clear();
}
