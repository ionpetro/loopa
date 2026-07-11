/**
 * Resolve a Clerk user id to display info for the public watch page.
 * Cached per process; returns null when Clerk isn't configured or lookup fails.
 */
import { createClerkClient } from "@clerk/backend";

export interface Author {
  name: string;
  imageUrl: string | null;
}

const cache = new Map<string, Author | null>();

export async function getAuthor(userId: string | null | undefined): Promise<Author | null> {
  if (!userId || !process.env.CLERK_SECRET_KEY) return null;
  if (cache.has(userId)) return cache.get(userId)!;
  try {
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const u = await clerk.users.getUser(userId);
    const name =
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      u.username ||
      u.primaryEmailAddress?.emailAddress ||
      "Loopa user";
    const author = { name, imageUrl: u.imageUrl ?? null };
    cache.set(userId, author);
    return author;
  } catch {
    cache.set(userId, null);
    return null;
  }
}
