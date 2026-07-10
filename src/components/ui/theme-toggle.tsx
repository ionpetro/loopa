"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

const ORDER = ["system", "light", "dark"] as const;
type Mode = (typeof ORDER)[number];
const ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

/** Three-way theme picker rendered inside Clerk's manage-account modal.
 * Renders the system state until mounted so the server and first client
 * render agree (next-themes reads localStorage). */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current: Mode = mounted && ORDER.includes(theme as Mode) ? (theme as Mode) : "system";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[1.05rem] font-bold">Theme</h1>
      <div className="flex gap-2">
        {ORDER.map((mode) => {
          const Icon = ICONS[mode];
          const active = current === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => setTheme(mode)}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm capitalize transition-colors ${
                active
                  ? "border-foreground bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-4" />
              {mode}
            </button>
          );
        })}
      </div>
    </div>
  );
}
