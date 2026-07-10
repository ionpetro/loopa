"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Animated "loopa" wordmark. At rest it's a solid wordmark; on hover each "o"
 * opens a small gap that sweeps exactly ONE revolution (the two o's spin in
 * opposite directions, slightly staggered), then seals back into a solid o.
 *
 * The o's are stroked circles with pathLength=100 so the sweep is a
 * dasharray/dashoffset animation (styles in globals.css). The spin is armed on
 * pointerenter — not :hover — and disarmed on the LAST circle's animationend,
 * so a revolution always completes cleanly even if the cursor leaves mid-spin.
 */
export function LoopaLogo({ className }: { className?: string }) {
  const [looping, setLooping] = useState(false);
  return (
    <svg
      viewBox="0 0 193 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="loopa"
      role="img"
      className={cn("loopa-logo", looping && "is-looping", className)}
      onPointerEnter={() => setLooping(true)}
      onAnimationEnd={(e) => {
        // Only the delayed (reverse) o ends last — that's the reset point.
        if ((e.target as Element).classList?.contains("loopa-o--rev")) setLooping(false);
      }}
    >
      {/* l */}
      <path
        fill="currentColor"
        d="M5.916 56.144C2.649 56.144 0 53.495 0 50.228V5.916C0 2.649 2.649 0 5.916 0C9.183 0 11.832 2.649 11.832 5.916V50.228C11.832 53.495 9.183 56.144 5.916 56.144Z"
      />
      {/* p: stem (descender) + bowl ring */}
      <path
        fill="currentColor"
        d="M115.117 71.997C111.893 71.997 109.279 69.383 109.279 66.159V24.476C109.279 21.209 111.927 18.56 115.195 18.56C118.462 18.56 121.111 21.209 121.111 24.476V66.159C121.111 69.383 118.342 71.997 115.117 71.997Z"
      />
      <circle className="loopa-static-ring" cx="130.93" cy="37.352" r="14.54" />
      {/* a: bowl ring + right stem */}
      <circle className="loopa-static-ring" cx="170.97" cy="37.352" r="14.54" />
      <path
        fill="currentColor"
        d="M187.132 56.144C183.929 56.144 181.332 53.547 181.332 50.344V24.36C181.332 21.157 183.929 18.56 187.132 18.56C190.335 18.56 192.932 21.157 192.932 24.36V50.344C192.932 53.547 190.335 56.144 187.132 56.144Z"
      />
      {/* the looping o's */}
      <circle className="loopa-o" cx="38.26" cy="37.352" r="14.54" pathLength="100" />
      <circle className="loopa-o loopa-o--rev" cx="85.26" cy="37.352" r="14.54" pathLength="100" />
    </svg>
  );
}
