import Kernel, { ConflictError, NotFoundError } from "@onkernel/sdk";
import { log } from "./log.ts";

let client: Kernel | null = null;

export function kernelClient(): Kernel {
  if (!client) {
    const apiKey = process.env.KERNEL_API_KEY;
    if (!apiKey) throw new Error("KERNEL_API_KEY is not set");
    client = new Kernel({ apiKey });
  }
  return client;
}

export interface KernelBrowser {
  sessionId: string;
  cdpWsUrl: string;
  liveViewUrl?: string;
}

/** Saved-login profile to load into a browser (cookies + local storage). */
export interface KernelProfileRef {
  name: string;
  /**
   * Persist session state back into the profile when the browser is DELETED
   * (deleteKernelBrowser or Kernel's idle timeout — a plain CDP disconnect
   * saves nothing). Only one writing browser per profile at a time.
   */
  saveChanges?: boolean;
}

export async function createKernelBrowser(
  viewport?: { width: number; height: number },
  profile?: KernelProfileRef,
): Promise<KernelBrowser> {
  const created = await kernelClient().browsers.create({
    // 10 min idle timeout — a stuck job shouldn't burn browser hours
    timeout_seconds: 600,
    // size the virtual display to the window at creation, otherwise the display
    // defaults to 1920x1080 and the live view shows the window floating in dead space
    ...(viewport ? { viewport } : {}),
    ...(profile ? { profile: { name: profile.name, save_changes: profile.saveChanges ?? false } } : {}),
  });
  return {
    sessionId: created.session_id,
    cdpWsUrl: created.cdp_ws_url,
    liveViewUrl: created.browser_live_view_url,
  };
}

export async function deleteKernelBrowser(sessionId: string): Promise<void> {
  try {
    await kernelClient().browsers.deleteByID(sessionId);
  } catch (err) {
    // best-effort cleanup; Kernel's idle timeout reaps it regardless
    log.warn(`browser ${sessionId}`, `delete failed (idle timeout will reap it): ${err instanceof Error ? err.message : err}`);
  }
}

// --- saved-login profiles ----------------------------------------------------
//
// One Kernel profile per (user, site). The name is deterministic, so no local
// registry is needed — Kernel is the source of truth and existence is checked
// by name. Profile names allow letters, numbers, dots, underscores, hyphens.

const profileSlug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-");

export function profileNameFor(userId: string, host: string): string {
  return profileSlug(`login.${userId}.${host.replace(/^www\./, "")}`).slice(0, 255);
}

/** Create the named profile if it doesn't exist yet. */
export async function ensureKernelProfile(name: string): Promise<void> {
  try {
    await kernelClient().profiles.create({ name });
  } catch (err) {
    if (err instanceof ConflictError) return; // already exists
    throw err;
  }
}

export async function kernelProfileExists(name: string): Promise<boolean> {
  try {
    await kernelClient().profiles.retrieve(name);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}
