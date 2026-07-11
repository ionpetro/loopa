export interface LoopaParams {
  goal: string;
  startUrl: string;
}

export interface ObservedElement {
  i: number;
  tag: string;
  role: string;
  name: string;
  ph: string;
  href: string;
  dialog: boolean;
  sel: string | null;
  selText: string | null;
}

export interface Observation {
  url: string;
  title: string;
  dialogOpen: boolean;
  elements: ObservedElement[];
  shot?: string; // base64 jpeg
}

export type BrowserActionName = "goto" | "click" | "type" | "hover" | "scroll" | "wait";

export interface BrowserAction {
  action: BrowserActionName;
  targetIndex?: number;
  url?: string;
  text?: string;
  dy?: number;
  ms?: number;
  caption?: string;
}

export interface ActionResult {
  ok: boolean;
  url: string;
  error?: string;
}

/** A frame on disk plus its capture time (ms since recording start). */
export interface FrameRef {
  t: number;
  file: string;
}

export interface TimedCaption {
  t: number; // ms since recording start
  text: string;
}

/** Replayable recipe step (compatible with the original feature-video-agent schema). */
export interface RecipeStep {
  action: BrowserActionName;
  caption?: string;
  waitAfter?: number;
  url?: string;
  dy?: number;
  ms?: number;
  text?: string;
  delay?: number;
  exact?: boolean;
  selector?: string;
  role?: string;
  name?: string;
  dialog?: boolean;
}

export interface Recipe {
  name: string;
  title: string;
  subtitle?: string;
  brand?: string;
  outro?: string;
  goal: string;
  output: { fps: number; width: number; height: number; quality: number };
  steps: RecipeStep[];
}

export type JobStatus = "recording" | "composing" | "done" | "error";

export interface ActionLog {
  n: number;
  action: string;
  caption: string;
  ok: boolean;
  error?: string;
}

export interface LoopaJob {
  id: string;
  goal: string;
  title?: string;
  startUrl: string;
  status: JobStatus;
  userId?: string;
  sessionId?: string;
  liveViewUrl?: string;
  actions: ActionLog[];
  videoPath?: string;
  videoUrl?: string;
  thumbUrl?: string;
  durationSec?: number;
  error?: string;
  createdAt: number;
  /** Durable copy of the replay recipe (recipe.json is on swept local disk). */
  recipe?: Recipe;
  usage?: JobUsage;
  /** Caption windows on the video timeline — the watch player's chapters. */
  chapters?: { title: string; start: number }[];
}

/** Per-run resource accounting — the raw material for quotas and pricing. */
export interface JobUsage {
  model?: string;
  browserSec?: number;
  composeSec?: number;
  frames?: number;
  background?: string;
}

/** One piece of a stored chat message (mirrors the client's ChatPart shape). */
export type ChatPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string };

/** Everything the UI can receive over the session SSE stream. */
export type SessionEvent =
  | { type: "agent_text"; text: string }
  | { type: "agent_turn_done" }
  | { type: "tool_call"; name: string }
  | { type: "plan"; goal: string; startUrl: string }
  | { type: "needs_login"; url: string; domain: string; hosted?: boolean }
  | { type: "login_done"; confirmed: boolean }
  | { type: "job_created"; jobId: string; goal: string; startUrl: string }
  | { type: "live_view"; jobId: string; url: string }
  | { type: "action"; jobId: string; n: number; action: string; caption: string; ok: boolean; error?: string }
  | { type: "job_status"; jobId: string; status: JobStatus; error?: string }
  | { type: "compose_progress"; jobId: string; stage: string; pct?: number }
  | { type: "video_ready"; jobId: string; videoUrl: string; durationSec: number; chapters?: { title: string; start: number }[] }
  | { type: "error"; message: string };
