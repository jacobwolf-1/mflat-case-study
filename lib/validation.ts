import type { SportCode } from "./types";

export const MAX_DAYS = 7;
export const DEFAULT_DAYS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in strict YYYY-MM-DD form (e.g. rejects 2026-13-40). */
export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export type AvailabilityQuery = { sport: SportCode; date: string; days: number };

export type ParseResult =
  | { ok: true; value: AvailabilityQuery }
  | { ok: false; error: string };

/**
 * Validates the raw query params for the availability endpoint. Pure and
 * framework-free so it can be unit-tested without spinning up Next. Sport-code
 * membership is intentionally left to the catalog lookup (which returns 404 for
 * a sport with no fields); this checks presence, date shape, and the day bound.
 */
export function parseAvailabilityQuery(input: {
  sport: string | null;
  date: string | null;
  days: string | null;
}): ParseResult {
  const { sport, date } = input;
  if (!sport || !date) {
    return { ok: false, error: "Missing required params: sport, date" };
  }
  if (!isValidDateString(date)) {
    return { ok: false, error: "Invalid date. Expected YYYY-MM-DD." };
  }
  const days = Number(input.days ?? String(DEFAULT_DAYS));
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return {
      ok: false,
      error: `Invalid days value. Expected an integer between 1 and ${MAX_DAYS}.`,
    };
  }
  return { ok: true, value: { sport: sport as SportCode, date, days } };
}
