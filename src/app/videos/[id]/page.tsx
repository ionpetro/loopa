"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckIcon, ChevronDownIcon, ClapperboardIcon, CopyIcon, DownloadIcon, LinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StudioHeader } from "@/components/studio-header";
import { LoopaPlayer, type VideoChapter } from "@/components/demo-player";
import { apiUrl } from "@/lib/api-base";
import { timeAgo } from "@/lib/timeago";

interface RecipeStep {
  action: string;
  caption?: string;
  url?: string;
  dy?: number;
  ms?: number;
  text?: string;
  selector?: string;
  role?: string;
  name?: string;
}

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
  recipe: { goal: string; steps: RecipeStep[] } | null;
}

/** Human-readable target/detail for one recipe step. */
function stepDetail(s: RecipeStep): string {
  if (s.action === "goto") return s.url ?? "";
  if (s.action === "scroll") return `${s.dy ?? 0}px`;
  if (s.action === "wait") return `${s.ms ?? 0}ms`;
  const target = s.name
    ? `${s.role ?? "element"} “${s.name}”`
    : s.text && s.action !== "type"
      ? `“${s.text}”`
      : (s.selector ?? "");
  if (s.action === "type") return `“${s.text ?? ""}” into ${target || "input"}`;
  return target;
}

export default function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<WatchData | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [recipeCopied, setRecipeCopied] = useState(false);

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

  const copyRecipe = () => {
    if (!data?.recipe) return;
    navigator.clipboard.writeText(JSON.stringify(data.recipe, null, 2)).then(() => {
      setRecipeCopied(true);
      setTimeout(() => setRecipeCopied(false), 2000);
    });
  };

  const downloadRecipe = () => {
    if (!data?.recipe) return;
    const blob = new Blob([JSON.stringify(data.recipe, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.id}-recipe.json`;
    a.click();
    URL.revokeObjectURL(url);
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
              <Link href="/">back to Loopa</Link>
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
            <LoopaPlayer
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
                    <span className="text-sm">{data.author?.name ?? "Loopa"}</span>
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

            {data.recipe && data.recipe.steps.length > 0 && (
              <section className="rounded-xl border">
                <button
                  type="button"
                  onClick={() => setRecipeOpen((v) => !v)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                  aria-expanded={recipeOpen}
                >
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    recipe · {data.recipe.steps.length} steps
                  </span>
                  <ChevronDownIcon
                    className={`size-4 text-muted-foreground transition-transform ${recipeOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {recipeOpen && (
                  <Fragment>
                    <ol className="border-t">
                      {data.recipe.steps.map((s, i) => (
                        <li
                          key={i}
                          className="flex items-baseline gap-3 border-b px-4 py-2 last:border-b-0"
                        >
                          <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                            {i + 1}
                          </span>
                          <span className="w-14 shrink-0 font-mono text-xs uppercase">{s.action}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                            {stepDetail(s)}
                          </span>
                          {s.caption && (
                            <span className="hidden max-w-[38%] truncate text-xs italic text-muted-foreground/70 sm:block">
                              {s.caption}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                    <div className="flex gap-2 border-t px-4 py-3">
                      <Button size="sm" variant="outline" onClick={copyRecipe}>
                        {recipeCopied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
                        {recipeCopied ? "copied" : "copy json"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={downloadRecipe}>
                        <DownloadIcon /> recipe.json
                      </Button>
                    </div>
                  </Fragment>
                )}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
