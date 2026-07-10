/**
 * Tagged console logger — one greppable line per event:
 *
 *   2026-07-10T12:00:00.000Z INFO  [run run-1a2b] recording started (job job-3c4d)
 *
 * Tags group lines by lifecycle so a single `grep` reconstructs any story:
 * [http] requests, [mcp] tool calls, [session <id>] chat turns, [job <id>]
 * recordings, [run <id>] headless runs, [browser <id>] Kernel browsers.
 */
type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, tag: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${tag}] ${msg}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (tag: string, msg: string) => write("INFO", tag, msg),
  warn: (tag: string, msg: string) => write("WARN", tag, msg),
  /** Pass the caught value as `err` — Errors log their stack, anything else its String(). */
  error: (tag: string, msg: string, err?: unknown) =>
    write("ERROR", tag, err === undefined ? msg : `${msg}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
};

/** One-line preview of free-form text (user messages, goals) for log lines. */
export function clip(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Seconds elapsed since a Date.now() timestamp, formatted for log lines. */
export function since(startMs: number): string {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}
