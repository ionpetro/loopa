"use client";

import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { FilmIcon, PaletteIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoopaLogo } from "@/components/loopa-logo";
import { ThemeSelector } from "@/components/ui/theme-toggle";

/** The Loopa navbar: logo and auth. `children` renders extra controls
 * (e.g. the home page's stage-expand button) left of the auth area. */
export function StudioHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-5">
      <Link href="/" aria-label="loopa — home">
        <LoopaLogo className="h-6 w-auto" />
      </Link>
      <div className="flex items-center gap-3">
        {children}
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
            <UserButton.UserProfilePage
              label="Theme"
              url="theme"
              labelIcon={<PaletteIcon className="size-4" />}
            >
              <ThemeSelector />
            </UserButton.UserProfilePage>
          </UserButton>
        </Show>
      </div>
    </header>
  );
}
