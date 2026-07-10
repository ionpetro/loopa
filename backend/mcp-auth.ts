/**
 * OAuth protection for the /mcp endpoint, per the MCP authorization spec
 * (OAuth 2.1 + RFC 9728 protected-resource metadata).
 *
 * Clerk is the authorization server: this file only verifies bearer tokens and
 * serves discovery metadata pointing at Clerk's Frontend API, which handles
 * /authorize, /token, and dynamic client registration. The client flow is what
 * MCP clients (Claude Code, Cursor, MCP Inspector) already speak: hit /mcp →
 * 401 with WWW-Authenticate → fetch resource metadata → register + PKCE →
 * retry with an oat_… access token.
 */
import http from "node:http";
import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { log } from "../src/engine/log.ts";

function publishableKey(): string | undefined {
  return process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

/** Clerk Frontend API origin, decoded from the publishable key (pk_*_base64(domain$)). */
export function clerkFrontendApi(): string | undefined {
  const pk = publishableKey();
  const m = pk?.match(/^pk_(test|live)_(.+)$/);
  if (!m) return undefined;
  try {
    const domain = Buffer.from(m[2], "base64").toString("utf8").replace(/\$$/, "");
    return domain ? `https://${domain}` : undefined;
  } catch {
    return undefined;
  }
}

export function oauthConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY && clerkFrontendApi());
}

let clerk: ClerkClient | null = null;
function getClerk(): ClerkClient {
  clerk ??= createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: publishableKey(),
  });
  return clerk;
}

/** authenticateRequest wants a fetch Request; headers are all it needs here. */
function toFetchRequest(req: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  return new Request(url, { method: req.method ?? "POST", headers });
}

export interface McpAuth {
  /** Clerk user the token belongs to; undefined for the static-token escape hatch. */
  userId?: string;
  /** OAuth client the token was issued to (which agent/tool is calling). */
  clientId?: string;
}

/**
 * Authorize an /mcp request. Order matters: the static MCP_AUTH_TOKEN (if set)
 * is checked first so headless automation keeps working without an OAuth
 * dance; anything else must present a valid Clerk OAuth access token. Fails
 * closed when nothing is configured — an open /mcp lets anyone on the internet
 * spend Kernel/Cursor money. Bare local runs can opt out explicitly with
 * MCP_ALLOW_ANONYMOUS=1.
 */
export async function authorizeMcp(req: http.IncomingMessage): Promise<McpAuth | null> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const staticToken = process.env.MCP_AUTH_TOKEN;
  if (staticToken && token === staticToken) return {};

  if (oauthConfigured() && token) {
    try {
      const state = await getClerk().authenticateRequest(toFetchRequest(req), {
        acceptsToken: "oauth_token",
      });
      if (state.isAuthenticated) {
        const auth = state.toAuth();
        return { userId: auth.userId ?? undefined, clientId: auth.clientId ?? undefined };
      }
    } catch (err) {
      log.error("mcp-auth", "token verification failed", err instanceof Error ? err.message : err);
    }
    return null;
  }

  if (process.env.MCP_ALLOW_ANONYMOUS === "1") return {};
  if (!oauthConfigured() && !staticToken) {
    log.error(
      "mcp-auth",
      "rejecting /mcp request: no auth configured. Set CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY " +
        "(OAuth) or MCP_AUTH_TOKEN (static bearer), or MCP_ALLOW_ANONYMOUS=1 for bare local runs.",
    );
  }
  return null;
}

/** WWW-Authenticate challenge pointing clients at the discovery document. */
export function wwwAuthenticate(base: string): string {
  return (
    `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", ` +
    `error="invalid_token", error_description="Missing or invalid access token"`
  );
}

/** RFC 9728 protected-resource metadata for the /mcp resource. */
export function protectedResourceMetadata(base: string): Record<string, unknown> {
  return {
    resource: `${base}/mcp`,
    authorization_servers: oauthConfigured() ? [clerkFrontendApi()] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["email", "profile"],
  };
}

/**
 * Authorization-server metadata proxied from Clerk, for older MCP clients that
 * only look at the resource origin (RFC 8414) instead of following
 * resource_metadata. Cached: it changes only with the Clerk instance.
 */
let authServerMetadataCache: Record<string, unknown> | null = null;
export async function authServerMetadata(): Promise<Record<string, unknown> | null> {
  if (authServerMetadataCache) return authServerMetadataCache;
  const fapi = clerkFrontendApi();
  if (!fapi) return null;
  try {
    const res = await fetch(`${fapi}/.well-known/oauth-authorization-server`);
    if (!res.ok) return null;
    authServerMetadataCache = (await res.json()) as Record<string, unknown>;
    return authServerMetadataCache;
  } catch (err) {
    log.error("mcp-auth", "failed to fetch Clerk auth server metadata", err instanceof Error ? err.message : err);
    return null;
  }
}
