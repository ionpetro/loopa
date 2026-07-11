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

// --- managed auth --------------------------------------------------------------
//
// Kernel Managed Auth (paid plans): a connection binds a profile to a domain,
// login happens on a Kernel-hosted page (SSO/2FA handled, credentials never
// touch us or the model), and Kernel re-authenticates on its own via health
// checks. On the free tier every call here 403s — callers fall back to the
// live-view handoff.

/** Kernel keys auth connections on the bare domain, not the full host. */
export const authDomainFor = (host: string) => host.replace(/^www\./, "");

export interface ManagedLoginFlow {
  connectionId: string;
  /** Kernel-hosted page the user signs in on. */
  hostedUrl: string;
}

/** Find or create the auth connection binding this profile to the domain. */
export async function ensureAuthConnection(
  profileName: string,
  domain: string,
): Promise<{ id: string; authenticated: boolean }> {
  const page = await kernelClient().auth.connections.list({ profile_name: profileName, domain });
  const existing = page.items?.[0];
  if (existing) return { id: existing.id, authenticated: existing.status === "AUTHENTICATED" };
  // profile_name auto-creates the profile; save_credentials + health checks
  // default on, so Kernel re-auths by itself once the user logged in once.
  const created = await kernelClient().auth.connections.create({ domain, profile_name: profileName });
  return { id: created.id, authenticated: created.status === "AUTHENTICATED" };
}

/** Start a hosted login flow for the connection. */
export async function startManagedLogin(connectionId: string): Promise<ManagedLoginFlow> {
  const login = await kernelClient().auth.connections.login(connectionId, {});
  return { connectionId, hostedUrl: login.hosted_url };
}

/**
 * Poll the connection until its login flow settles or the deadline passes.
 * `userSaysDone` (the UI/MCP confirm) grants a short grace window, then the
 * connection's own status is the verdict — the user saying "done" cannot
 * overrule Kernel still reporting NEEDS_AUTH.
 */
export async function waitForManagedLogin(
  connectionId: string,
  deadlineMs: number,
  userSaysDone: () => boolean,
): Promise<boolean> {
  const GRACE_POLLS_AFTER_CONFIRM = 5;
  let pollsSinceConfirm = 0;
  while (Date.now() < deadlineMs) {
    const conn = await kernelClient().auth.connections.retrieve(connectionId);
    if (conn.status === "AUTHENTICATED" || conn.flow_status === "SUCCESS") return true;
    if (conn.flow_status === "FAILED" || conn.flow_status === "EXPIRED" || conn.flow_status === "CANCELED") return false;
    if (userSaysDone() && ++pollsSinceConfirm > GRACE_POLLS_AFTER_CONFIRM) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
