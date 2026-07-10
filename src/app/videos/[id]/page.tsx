"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckIcon, ClapperboardIcon, DownloadIcon, LinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StudioHeader } from "@/components/studio-header";
import { DemoPlayer, type VideoChapter } from "@/components/demo-player";
import { apiUrl } from "@/lib/api-base";
import { timeAgo } from "@/lib/timeago";

interface WatchData {
  id: string;
  title: string | null;
  goal: string;
  videoUrl: string;
  thumbUrl: string | null;
  durationSec: number | null;
  createdAt: number;
  chapters: VideoChapter[] | null;
  author: { name: string; imageUrl: string | null } | null;
}

export default function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<WatchData | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetch(apiUrl(`/api/videos/${id}`))
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(setData)
      .catch(() => setMissing(true));
  }, [id]);

  const share = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-background dark:bg-bg-deep">
      <StudioHeader />

      <main className="mx-auto max-w-5xl px-6 py-10">
        {missing && (
          <div className="flex flex-col items-center gap-3 py-32 text-center">
            <ClapperboardIcon className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">This video doesn&apos;t exist (or hasn&apos;t finished composing).</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/">back to the studio</Link>
            </Button>
          </div>
        )}

        {!data && !missing && (
          <div className="flex flex-col gap-5">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-3">
                <Skeleton className="h-7 w-72 max-w-full" />
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-28" />
              </div>
            </div>
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-5">
            <DemoPlayer
              className="shadow-[0_0_80px_-20px_oklch(0_0_0/60%)]"
              src={data.videoUrl}
              poster={data.thumbUrl ?? undefined}
              chapters={data.chapters}
            />
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-3">
                <h1 className="font-display text-2xl leading-tight tracking-tight">
                  {data.title ?? data.goal}
                </h1>
                <div className="flex items-center gap-2.5">
                  {data.author?.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={data.author.imageUrl} alt="" className="size-8 rounded-full border" />
                  ) : (
                    <span className="flex size-8 items-center justify-center rounded-full border bg-muted">
                      <ClapperboardIcon className="size-4 text-muted-foreground" />
                    </span>
                  )}
                  <div className="flex flex-col">
                    <span className="text-sm">{data.author?.name ?? "Demo Studio"}</span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {timeAgo(data.createdAt)}
                      {data.durationSec ? ` · ${data.durationSec.toFixed(0)}s` : ""}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={share}>
                  {copied ? <CheckIcon className="text-ok" /> : <LinkIcon />}
                  {copied ? "copied" : "share"}
                </Button>
                <Button asChild size="sm">
                  <a href={`${data.videoUrl}?download`}>
                    <DownloadIcon /> download
                  </a>
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
