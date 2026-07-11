/** Base URL for the Loopa API (empty = same origin). */
export function apiBase(): string {
  const raw =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) ||
    (typeof process !== "undefined" && process.env.PUBLIC_URL) ||
    "";
  return raw.replace(/\/$/, "");
}

export function apiUrl(path: string): string {
  const base = apiBase();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
