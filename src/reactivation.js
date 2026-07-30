// Pure swap-eligibility logic for self-service license reactivation
// (Option B, approved 2026-07-29 — see docs/license_reactivation_options.md
// in the PowerSuite project knowledge). Kept separate from db.js/server.js
// so the cooldown-window math can be unit-tested without a live Postgres
// connection — engine-first per project convention.

export const REACTIVATION_POLICY = {
  cooldownDays: 30,
  maxSwapsPerWindow: 2,
};

const COOLDOWN_MS = REACTIVATION_POLICY.cooldownDays * 24 * 60 * 60 * 1000;

/**
 * Given the timestamps of every prior device swap for a license key
 * (as Date objects or ISO strings, any order, may include swaps outside
 * the window), decide whether a new swap is allowed right now.
 *
 * Only swaps that fall strictly within the trailing `cooldownDays` window
 * count against the limit — this is a *rolling* window, not a calendar
 * month, so it slides forward continuously rather than resetting on a
 * fixed date.
 *
 * @param {Array<string|Date>} allSwapTimestamps
 * @param {Date} [now] — injectable for deterministic tests
 * @returns {{allowed: boolean, swapsUsed: number, swapsRemaining: number, retryAt: Date|null}}
 */
export function evaluateSwapEligibility(allSwapTimestamps, now = new Date()) {
  const nowMs = now.getTime();
  const windowStart = nowMs - COOLDOWN_MS;

  const recentSwaps = (allSwapTimestamps || [])
    .map((t) => (t instanceof Date ? t : new Date(t)))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() > windowStart)
    .sort((a, b) => a.getTime() - b.getTime());

  const swapsUsed = recentSwaps.length;
  const allowed = swapsUsed < REACTIVATION_POLICY.maxSwapsPerWindow;

  // If blocked, the next slot frees up exactly `cooldownDays` after the
  // OLDEST swap currently counted in the window ages out of it — not
  // after the most recent one, and not a fixed calendar date.
  const retryAt = allowed ? null : new Date(recentSwaps[0].getTime() + COOLDOWN_MS);

  return {
    allowed,
    swapsUsed,
    swapsRemaining: Math.max(0, REACTIVATION_POLICY.maxSwapsPerWindow - swapsUsed),
    retryAt,
  };
}

/** Formats a retry date as YYYY-MM-DD for the lockout message (UTC, matches TIMESTAMPTZ storage). */
export function formatRetryDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Builds the exact user-facing lockout message per the locked spec:
 * states the retry date and directs to support — no other wording variant.
 */
export function buildLockoutMessage(retryAt) {
  return `You've moved this license too many times recently. Try again after ${formatRetryDate(retryAt)}, or contact hetsak@gmail.com.`;
}
