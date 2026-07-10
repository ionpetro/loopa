"use client";

import { cn } from "@/lib/utils";

/**
 * App-wide loading indicator: the logo's two o's running their open-sweep-seal
 * revolution on an endless loop (counter-rotating, slightly staggered). Same
 * keyframes as the logo hover — they end where they start, so the loop is
 * seamless. Size via className height; inherits color.
 */
export function LoopaLoader({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 88.14 41.14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="status"
      aria-label="loading"
      className={cn("loopa-loader", className)}
    >
      <circle className="loopa-o" cx="20.57" cy="20.57" r="14.54" pathLength="100" />
      <circle className="loopa-o loopa-o--rev" cx="67.57" cy="20.57" r="14.54" pathLength="100" />
    </svg>
  );
}
