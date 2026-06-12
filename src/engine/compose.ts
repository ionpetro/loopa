import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Overlays } from "./browser-session.ts";
import type { FrameRef, TimedCaption } from "./types.ts";

const ff = (args: string[], cwd: string) =>
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { cwd, stdio: ["ignore", "ignore", "inherit"] });

export interface ComposeInput {
  frames: FrameRef[];
  captions: TimedCaption[];
  overlays: Overlays;
  outDir: string;
  width: number;
  height: number;
  fps: number;
}

export interface ComposeResult {
  finalPath: string;
  rawPath: string;
  durationSec: number;
  frameCount: number;
}

/**
 * Stitch screencast frames into a captioned, branded MP4 with intro/outro.
 * Inter-frame duration is capped at 1.6s — the screencast only emits frames
 * when pixels change, so long agent "thinking" pauses collapse automatically.
 */
export function composeVideo(input: ComposeInput): ComposeResult {
  const { frames, captions, overlays, outDir } = input;
  const W = input.width, H = input.height, FPS = input.fps;
  if (!frames.length) throw new Error("no frames captured");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-studio-"));
  fs.mkdirSync(outDir, { recursive: true });

  const t0 = frames[0].t;
  const lines: string[] = [];
  let total = 0;
  frames.forEach((f, i) => {
    let dur = i < frames.length - 1 ? (frames[i + 1].t - f.t) / 1000 : 0.8;
    dur = Math.max(0.02, Math.min(1.6, dur));
    total += dur;
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${dur.toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(path.join(tmp, "concat.txt"), lines.join("\n") + "\n");

  overlays.caps.forEach((b, i) => fs.writeFileSync(path.join(tmp, `cap_${i}.png`), Buffer.from(b, "base64")));
  if (overlays.brand) fs.writeFileSync(path.join(tmp, "brand.png"), Buffer.from(overlays.brand, "base64"));
  fs.writeFileSync(path.join(tmp, "intro.png"), Buffer.from(overlays.intro, "base64"));
  fs.writeFileSync(path.join(tmp, "outro.png"), Buffer.from(overlays.outro, "base64"));

  // Caption windows on the compressed timeline: map each caption's real capture
  // time to video time by summing the capped frame durations up to it.
  const videoTimeAt = (t: number): number => {
    let vt = 0;
    for (let i = 0; i < frames.length - 1; i++) {
      if (frames[i].t >= t) break;
      vt += Math.max(0.02, Math.min(1.6, (frames[i + 1].t - frames[i].t) / 1000));
    }
    return vt;
  };

  const inputs = ["-f", "concat", "-safe", "0", "-i", "concat.txt"];
  overlays.caps.forEach((_, i) => inputs.push("-i", `cap_${i}.png`));
  const brandIdx = overlays.brand ? 1 + overlays.caps.length : -1;
  if (overlays.brand) inputs.push("-i", "brand.png");

  let fc = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS}[bg]`;
  let cur = "bg";
  captions.forEach((c, i) => {
    const s = Math.max(0, videoTimeAt(Math.max(c.t, t0)));
    const e = i < captions.length - 1 ? Math.max(s, videoTimeAt(captions[i + 1].t)) : total;
    const lbl = `c${i}`;
    fc += `;[${cur}][${1 + i}:v]overlay=x=(W-w)/2:y=H-h-44:enable='between(t,${s.toFixed(2)},${e.toFixed(2)})'[${lbl}]`;
    cur = lbl;
  });
  if (overlays.brand) { fc += `;[${cur}][${brandIdx}:v]overlay=40:34[bz]`; cur = "bz"; }
  fc += `;[${cur}]format=yuv420p[v]`;
  ff([...inputs, "-filter_complex", fc, "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "main.mp4"], tmp);

  ff(["-loop", "1", "-i", "intro.png", "-t", "2.0", "-r", String(FPS), "-vf", `scale=${W}:${H},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "intro.mp4"], tmp);
  ff(["-loop", "1", "-i", "outro.png", "-t", "1.6", "-r", String(FPS), "-vf", `scale=${W}:${H},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "outro.mp4"], tmp);
  ff(["-i", "intro.mp4", "-i", "main.mp4", "-i", "outro.mp4",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "final.mp4"], tmp);

  const finalPath = path.join(outDir, "final.mp4");
  const rawPath = path.join(outDir, "raw.mp4");
  fs.copyFileSync(path.join(tmp, "final.mp4"), finalPath);
  fs.copyFileSync(path.join(tmp, "main.mp4"), rawPath);
  fs.rmSync(tmp, { recursive: true, force: true });

  return { finalPath, rawPath, durationSec: +(total + 3.6).toFixed(2), frameCount: frames.length };
}
