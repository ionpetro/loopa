"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ClapperboardIcon, PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StudioHeader } from "@/components/studio-header";
import { apiUrl } from "@/lib/api-base";
import { timeAgo } from "@/lib/timeago";

interface VideoItem {
  id: string;
  title: string | null;
  goal: string;
  videoUrl: string;
  thumbUrl: string | null;
  durationSec: number | null;
  createdAt: number;
}

export default function VideosPage() {
  const { getToken } = useAuth();
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken().catch(() => null);
        const res = await fetch(apiUrl("/api/me/videos"), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        const body = (await res.json()) as { videos: VideoItem[] };
        if (!cancelled) setVideos(body.videos);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return (
    <div className="min-h-screen bg-background dark:bg-bg-deep">
      <StudioHeader />

      <main className="mx-auto max-w-6xl px-6 py-10">
        {error && <p className="py-20 text-center font-mono text-xs text-rec">{error}</p>}

        {!videos && !error && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col overflow-hidden rounded-xl border bg-card dark:bg-background">
                <Skeleton className="aspect-video rounded-none" />
                <div className="flex flex-col gap-2 p-3.5">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
              </div>
            ))}
          </div>
        )}

        {videos?.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-32 text-center">
            <ClapperboardIcon className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No videos yet — direct your first take.</p>
            <Button asChild size="sm">
              <Link href="/">start recording</Link>
            </Button>
          </div>
        )}

        {videos && videos.length > 0 && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((v) => (
              <Link
                key={v.id}
                href={`/videos/${v.id}`}
                className="group flex flex-col overflow-hidden rounded-xl border bg-card dark:bg-background"
              >
                <div className="relative aspect-video bg-black">
                  {/* Poster spares the grid a metadata fetch per tile; older videos without one keep the first-frame fallback. */}
                  {v.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="size-full object-cover" src={v.thumbUrl} alt="" loading="lazy" />
                  ) : (
                    // preload="none": a grid of tiles must not each fetch
                    // video metadata — that made the page crawl before thumbs.
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video className="size-full object-cover" src={v.videoUrl} preload="none" muted playsInline />
                  )}
                  <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                    <PlayIcon className="size-9 fill-white text-white drop-shadow" />
                  </span>
                  {v.durationSec != null && (
                    <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white">
                      {v.durationSec.toFixed(0)}s
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1 p-3.5">
                  <span className="line-clamp-2 text-sm leading-snug">{v.title ?? v.goal}</span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {timeAgo(v.createdAt)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
