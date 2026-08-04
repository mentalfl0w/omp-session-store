/**
 * session-store — time parsing utilities.
 *
 * Supports three formats:
 *   1. Pure date:       "2026-07-30"          → that day 00:00 local
 *   2. ISO datetime:    "2026-07-30T17:30:00" → exact (timezone optional, defaults to local)
 *   3. Relative:        "3d" "6h" "2w" "30m"  → now - N
 *
 * Returns unix SECONDS (matches history.db.created_at and threads.updated_at).
 */

export function parseTime(s?: string): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;

  // Relative: "3d" "6h" "2w" "30m"
  const rel = trimmed.match(/^(\d+)([dhwm])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const units: Record<string, number> = { d: 86400, h: 3600, w: 604800, m: 60 };
    return Math.floor(Date.now() / 1000) - n * units[rel[2]];
  }

  // Pure date: "2026-07-30"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return Math.floor(new Date(trimmed + "T00:00:00").getTime() / 1000);
  }

  // ISO datetime: "2026-07-30T17:30:00" or "2026-07-30T17:30:00+08:00"
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const ts = Date.parse(trimmed);
    if (!isNaN(ts)) return Math.floor(ts / 1000);
  }

  // Try Date.parse as last resort
  const fallback = Date.parse(trimmed);
  if (!isNaN(fallback)) return Math.floor(fallback / 1000);

  return undefined;
}

/** Format unix seconds to ISO string for display. */
export function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
