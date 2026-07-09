/**
 * Per-user spend protection. Every run costs real money (cloud browser +
 * agent tokens), and before this the only backpressure was global — one
 * user could queue unlimited runs or open N chat sessions for N browsers.
 *
 * Anonymous callers (no userId) are exempt: they only exist on bare local
 * setups or via the static MCP_AUTH_TOKEN, both operator-controlled.
 */
import { countUserWorkSince } from "./db.ts";
import { activeJobCountFor } from "./jobs.ts";
import { activeRunCountFor } from "./headless-run.ts";

const dailyLimit = () => Number(process.env.DAILY_RUN_LIMIT ?? 10);
const maxActive = () => Number(process.env.MAX_ACTIVE_RUNS_PER_USER ?? 2);

/** Throws a user-facing Error when the caller is over quota. */
export async function assertRunQuota(userId: string | undefined): Promise<void> {
  if (!userId) return;

  // Concurrency: max() not sum() — an MCP run and the job it spawns are the
  // same underlying work. Runs are counted from creation, so flooding the
  // queue (where jobs don't exist yet) is also capped.
  const active = Math.max(activeJobCountFor(userId), activeRunCountFor(userId));
  if (maxActive() > 0 && active >= maxActive()) {
    throw new Error(
      `You already have ${active} video(s) in progress — wait for them to finish before starting another.`,
    );
  }

  const limit = dailyLimit();
  if (limit <= 0) return; // 0 or negative disables the daily cap
  const used = await countUserWorkSince(userId, 24);
  // null = DB unavailable: fail open, the concurrency cap above still applies.
  if (used != null && used >= limit) {
    throw new Error(`Daily video limit reached (${limit} per 24h). Try again later.`);
  }
}
