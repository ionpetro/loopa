import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Overlays } from "./browser-session.ts";
import type { FrameRef, TimedCaption } from "./types.ts";

/**
 * Run ffmpeg without blocking the event loop; the timeout keeps a hung encode
 * from wedging the job forever. With `onTime`, ffmpeg's `-progress` stream is
 * parsed and the callback receives output seconds encoded so far.
 */
const ff = (args: string[], cwd: string, onTime?: (sec: number) => void) =>
  new Promise<void>((resolve, reject) => {
    const progressArgs = onTime ? ["-progress", "pipe:1", "-nostats"] : [];
    const proc = spawn("ffmpeg", ["-y", "-loglevel", "error", ...progressArgs, ...args], { cwd });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const m = buf.slice(0, nl).match(/^out_time_us=(\d+)/);
        buf = buf.slice(nl + 1);
        if (m && onTime) onTime(Number(m[1]) / 1e6);
      }
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10 * 60_000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      // exit codes alone are useless; the actual cause is on stderr.
      else reject(new Error(`ffmpeg exited with ${code}${stderr ? `\nffmpeg stderr: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });

/**
 * Full-frame backdrops the (padded, rounded) recording is composited onto —
 * one is picked at random per video from assets/backgrounds. Resolved from the
 * repo root rather than `import.meta.url` so it survives Next.js's webpack
 * bundling (which rewrites `new URL(..., import.meta.url)`).
 */
const BG_PATH = path.join(process.cwd(), "src/engine/assets/background.png");
const BG_DIR = path.join(process.cwd(), "src/engine/assets/backgrounds");

function pickBackground(): string | null {
  try {
    const files = fs.readdirSync(BG_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
    if (files.length) return path.join(BG_DIR, files[Math.floor(Math.random() * files.length)]);
  } catch {}
  return fs.existsSync(BG_PATH) ? BG_PATH : null;
}

export interface ComposeInput {
  frames: FrameRef[];
  captions: TimedCaption[];
  overlays: Overlays;
  outDir: string;
  width: number;
  height: number;
  fps: number;
  /**
   * Recording-clock spans (ms) where an action was driving the page. Frames
   * inside them play at real speed; each contiguous idle run between them is
   * compressed to at most MAX_IDLE_SEC of video, so agent thinking pauses
   * don't pad the cut even when the page keeps animating.
   */
  activeWindows?: { start: number; end: number }[];
  /** Encode progress, 0..1 (based on ffmpeg's -progress out_time). */
  onProgress?: (pct: number) => void;
}

export interface ComposeResult {
  finalPath: string;
  durationSec: number;
  frameCount: number;
}

// One encode at a time: two concurrent ffmpeg runs starve the 1GB box —
// observed in prod as encodes crawling at ~2%/min, health checks flapping,
// and one encode getting OOM-killed ("ffmpeg exited with null").
let encodeQueue: Promise<unknown> = Promise.resolve();

/**
 * Stitch screencast frames into a captioned, branded MP4.
 * Inter-frame duration is capped at 1.6s — the screencast only emits frames
 * when pixels change, so long agent "thinking" pauses collapse automatically.
 */
export function composeVideo(input: ComposeInput): Promise<ComposeResult> {
  const result = encodeQueue.then(() => composeVideoNow(input));
  encodeQueue = result.catch(() => {});
  return result;
}

async function composeVideoNow(input: ComposeInput): Promise<ComposeResult> {
  const { frames, captions, overlays, outDir } = input;
  const W = input.width, H = input.height, FPS = input.fps;
  if (!frames.length) throw new Error("no frames captured");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-studio-"));
  fs.mkdirSync(outDir, { recursive: true });

  const t0 = frames[0].t;
  const durs = frames.map((f, i) =>
    i < frames.length - 1 ? Math.max(0.02, Math.min(1.6, (frames[i + 1].t - f.t) / 1000)) : 0.8,
  );

  // Collapse idle time: frames outside every action window (grown by a small
  // margin so a caption placed just before its action stays in sync) are agent
  // thinking pauses. Each contiguous idle run becomes at most MAX_IDLE_SEC of
  // video — the per-frame 1.6s cap above only handles static pages; an
  // animated page keeps emitting frames through a 30s pause and would land it
  // in the cut verbatim. Long runs must DROP frames, not just shrink
  // durations: hundreds of idle frames floored at 0.02s each still add up.
  const MAX_IDLE_SEC = 1.0;
  const keep = new Array<boolean>(frames.length).fill(true);
  const windows = input.activeWindows ?? [];
  if (windows.length) {
    const inWindow = (t: number) => windows.some((w) => t >= w.start - 300 && t <= w.end + 500);
    for (let i = 0; i < frames.length - 1; ) {
      if (inWindow(frames[i].t)) { i++; continue; }
      let j = i, sum = 0;
      while (j < frames.length - 1 && !inWindow(frames[j].t)) sum += durs[j++];
      if (sum > MAX_IDLE_SEC) {
        const maxKept = Math.max(1, Math.floor(MAX_IDLE_SEC / 0.04)); // ≈25fps within the collapsed run
        const kept: number[] = [];
        const n = j - i;
        if (n <= maxKept) for (let x = i; x < j; x++) kept.push(x);
        else for (let s = 0; s < maxKept; s++) kept.push(i + Math.floor((s * n) / maxKept));
        for (let x = i; x < j; x++) keep[x] = false;
        for (const x of kept) { keep[x] = true; durs[x] = MAX_IDLE_SEC / kept.length; }
      }
      i = j;
    }
  }

  const lines: string[] = [];
  let total = 0;
  frames.forEach((f, i) => {
    if (!keep[i]) return;
    total += durs[i];
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${durs[i].toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(path.join(tmp, "concat.txt"), lines.join("\n") + "\n");

  overlays.caps.forEach((b, i) => fs.writeFileSync(path.join(tmp, `cap_${i}.png`), Buffer.from(b, "base64")));

  // Caption windows on the compressed timeline: map each caption's real capture
  // time to video time by summing the kept, idle-collapsed durations up to it.
  const videoTimeAt = (t: number): number => {
    let vt = 0;
    for (let i = 0; i < frames.length - 1; i++) {
      if (frames[i].t >= t) break;
      if (keep[i]) vt += durs[i];
    }
    return vt;
  };

  // Inset the recording inside the backdrop with even padding + rounded corners.
  const PAD = Math.round(W * 0.04);
  const RADIUS = Math.round(Math.min(W, H) * 0.025);
  const IW = W - PAD * 2, IH = H - PAD * 2;

  // Input 0 = recording frames, 1 = backdrop, then captions.
  // Fall back to a solid-black backdrop if no image assets exist.
  const bg = pickBackground();
  const bgInput = bg ? ["-i", bg] : ["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`];
  // Input 2 = the rounded-corner mask. Single frame, NO -loop: framesync
  // repeats the last frame after EOF, whereas a looped input never EOFs and
  // the whole graph encodes forever.
  const inputs = ["-f", "concat", "-safe", "0", "-i", "concat.txt", ...bgInput, "-i", "mask.png"];
  overlays.caps.forEach((_, i) => inputs.push("-i", `cap_${i}.png`));
  const capBase = 3;

  // Rounded corners via a mask rendered ONCE: running geq per pixel per frame
  // starved the encoder so badly the 10-min watchdog SIGKILLed it mid-encode
  // (seen twice in prod, at 46% on 1cpu and 82% on 2cpu). The single-frame geq
  // pre-pass costs milliseconds; the per-frame cost becomes a plain alphamerge.
  const r = RADIUS;
  const maskExpr =
    `if(gt(abs(X-W/2),W/2-${r})*gt(abs(Y-H/2),H/2-${r}),` +
    `if(lte(hypot(abs(X-W/2)-(W/2-${r}),abs(Y-H/2)-(H/2-${r})),${r}),255,0),255)`;
  await ff(
    ["-f", "lavfi", "-i", `color=c=white:s=${IW}x${IH}`, "-frames:v", "1",
     "-vf", `format=gray,geq=lum='${maskExpr}'`, "mask.png"],
    tmp,
  );

  let fc =
    `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg]` +
    `;[0:v]scale=${IW}:${IH}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${FPS},format=rgba[fg0]` +
    `;[2:v]format=gray[mg];[mg][fg0]scale2ref[ms][fg1];[fg1][ms]alphamerge[fg]` +
    `;[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2[comp]`;
  let cur = "comp";
  captions.forEach((c, i) => {
    const s = Math.max(0, videoTimeAt(Math.max(c.t, t0)));
    const e = i < captions.length - 1 ? Math.max(s, videoTimeAt(captions[i + 1].t)) : total;
    const lbl = `c${i}`;
    fc += `;[${cur}][${capBase + i}:v]overlay=x=(W-w)/2:y=H-${PAD}-h-24:enable='between(t,${s.toFixed(2)},${e.toFixed(2)})'[${lbl}]`;
    cur = lbl;
  });
  fc += `;[${cur}]format=yuv420p[v]`;
  const onTime = input.onProgress
    ? (sec: number) => input.onProgress!(Math.max(0, Math.min(1, sec / total)))
    : undefined;
  // +faststart moves the moov index to the front so browsers can start
  // playback (and grid thumbnails can show metadata) without downloading the
  // whole file first.
  await ff([...inputs, "-filter_complex", fc, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-movflags", "+faststart", "main.mp4"], tmp, onTime);

  const finalPath = path.join(outDir, "final.mp4");
  fs.copyFileSync(path.join(tmp, "main.mp4"), finalPath);
  fs.rmSync(tmp, { recursive: true, force: true });

  return { finalPath, durationSec: +total.toFixed(2), frameCount: frames.length };
}
