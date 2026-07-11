"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { MaximizeIcon, PauseIcon, PlayIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface VideoChapter {
  title: string;
  start: number; // seconds on the video timeline
}

const RATES = [1, 1.25, 1.5, 2];

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Custom video controls with chaptered timeline (one segment per recorded
 * caption, Cursor-style). Degrades to a single unlabeled segment for older
 * videos without chapter data.
 */
export function LoopaPlayer({
  src,
  poster,
  chapters,
  className,
}: {
  src: string;
  poster?: string;
  chapters?: VideoChapter[] | null;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);

  const segs = useMemo(() => {
    if (!dur) return [];
    const cs = (chapters ?? [])
      .filter((c) => c.start < dur - 0.25)
      .sort((a, b) => a.start - b.start);
    const list = cs.length ? [...cs] : [{ title: "", start: 0 }];
    // The timeline must start at 0 — snap a near-zero first chapter, else pad.
    if (list[0].start > 0.5) list.unshift({ title: "", start: 0 });
    else list[0] = { ...list[0], start: 0 };
    return list.map((c, i) => ({ ...c, end: list[i + 1]?.start ?? dur }));
  }, [chapters, dur]);

  const activeIdx = segs.findIndex((s) => time >= s.start && time < s.end);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const cycleRate = () => {
    const next = (rateIdx + 1) % RATES.length;
    setRateIdx(next);
    if (videoRef.current) videoRef.current.playbackRate = RATES[next];
  };

  const seekWithin = (segStart: number, segEnd: number, e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const frac = (e.clientX - el.getBoundingClientRect().left) / el.clientWidth;
    if (videoRef.current) videoRef.current.currentTime = segStart + frac * (segEnd - segStart);
  };

  return (
    <div
      ref={wrapRef}
      className={cn("group relative overflow-hidden rounded-xl border bg-black", className)}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        className="aspect-video w-full cursor-pointer"
        src={src}
        poster={poster}
        autoPlay
        playsInline
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
      />

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 pb-3 pt-12">
        {/* chaptered timeline */}
        <div className="flex items-end gap-1.5">
          {segs.map((s, i) => {
            const played = Math.min(1, Math.max(0, (time - s.start) / (s.end - s.start)));
            return (
              <button
                key={i}
                type="button"
                title={s.title || undefined}
                className="group/seg flex min-w-0 flex-col gap-1.5 pb-0.5 text-left"
                style={{ flexGrow: s.end - s.start, flexBasis: 0 }}
                onClick={(e) => seekWithin(s.start, s.end, e)}
              >
                {segs.length > 1 && (
                  <span
                    className={cn(
                      "truncate font-mono text-[10px] leading-none tracking-wide transition-colors",
                      i === activeIdx ? "text-white" : "text-white/45 group-hover/seg:text-white/75",
                    )}
                  >
                    {s.title}
                  </span>
                )}
                <span className="block h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover/seg:h-1.5">
                  <span
                    className="block h-full rounded-full bg-white"
                    style={{ width: `${played * 100}%` }}
                  />
                </span>
              </button>
            );
          })}
        </div>

        {/* transport row */}
        <div className="flex items-center gap-3 text-white">
          <button type="button" onClick={toggle} className="transition-opacity hover:opacity-80">
            {playing ? <PauseIcon className="size-4.5 fill-white" /> : <PlayIcon className="size-4.5 fill-white" />}
          </button>
          <span className="font-mono text-xs tabular-nums text-white/90">
            {fmt(time)} / {fmt(dur)}
          </span>
          {segs[activeIdx]?.title && (
            <span className="truncate font-mono text-[10px] uppercase tracking-widest text-white/50">
              {segs[activeIdx].title}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={cycleRate}
            className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors hover:bg-white/25"
          >
            {RATES[rateIdx]}x
          </button>
          <button
            type="button"
            className="transition-opacity hover:opacity-80"
            onClick={() => void wrapRef.current?.requestFullscreen?.()}
          >
            <MaximizeIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
