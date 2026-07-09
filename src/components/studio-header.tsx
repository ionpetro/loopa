"use client";

import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { FilmIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/** The studio navbar: logo, theme toggle, and auth. `children` renders extra
 * controls (e.g. the home page's stage-expand button) left of the toggle. */
export function StudioHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-5">
      <Link href="/" className="font-display text-xl tracking-tight">
        demo<span className="text-rec">·</span>studio
      </Link>
      <div className="flex items-center gap-3">
        {children}
        <ThemeToggle />
        <Show when="signed-out">
          {/* One entry point — Clerk's sign-in screen links to sign-up. */}
          <SignInButton>
            <Button size="sm">sign in</Button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <UserButton>
            <UserButton.MenuItems>
              <UserButton.Link
                label="My videos"
                labelIcon={<FilmIcon className="size-4" />}
                href="/videos"
              />
            </UserButton.MenuItems>
          </UserButton>
        </Show>
      </div>
    </header>
  );
}
