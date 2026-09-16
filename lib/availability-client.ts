/**
 * Client for the two public NYC Parks availability endpoints.
 *
 * Endpoint 1 — bulk datetime snapshot:
 *   GET /api/athletic-fields?datetime=YYYY-MM-DD+H:mm
 *   Returns { dusk: "HH:MM", l: ["SYSTEM-ID", ...] }
 *   `l` is the complete list of reserved/unavailable field IDs at that moment.
 *   All fields NOT in `l` are available at that datetime.
 *
 * Endpoint 2 — per-field weekly detail:
 *   GET /api/athletic-fields?location=SYSTEM-ID&date=YYYY-MM-DD
 *   Returns per-slot permit information for a 7-day window starting at `date`.
 *
 * Both endpoints work with plain HTTP GET — no session, auth, or cookies needed.
 * Rate limit: unknown; we add a small delay between date requests.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import type {
  DatetimeAvailabilityResponse,
  FieldDetailResponse,
  FieldRecord,
  FieldAvailability,
  DayAvailability,
  PermitSlot,
} from "./types";

const BASE = "https://www.nycgovparks.org";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Slots run in 30-minute increments — 8:00 AM through dusk
const TYPICAL_SLOTS_PER_DAY = 24; // 12 hours / 0.5h

// Representative midday instant for the top-level "is this field reserved today?"
// snapshot. The UI and README describe this as the "noon snapshot"; keep this in
// sync with that language and with the availability API route.
export const SNAPSHOT_TIME = "12:00";

function cacheDir(): string {
  const dir = path.resolve(process.cwd(), "data/cache/availability");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fieldDetailCachePath(systemId: string, date: string): string {
  const dir = path.join(cacheDir(), "fields");
  mkdirSync(dir, { recursive: true });
  const safe = systemId.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(dir, `${safe}_${date}.json`);
}

async function get<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: "https://www.nycgovparks.org/permits/field-and-court/map",
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json() as Promise<T>;
}

/**
 * Returns the list of reserved field system IDs at a given date + time.
 * Results are cached to disk; the cache is considered fresh for 15 minutes.
 */
export async function getReservedIds(
  date: string,
  time = SNAPSHOT_TIME,
  opts?: { maxAgeMs?: number }
): Promise<DatetimeAvailabilityResponse> {
  const cacheKey = `${date}_${time.replace(":", "-")}`;
  const cachePath = path.join(cacheDir(), `snapshot_${cacheKey}.json`);
  const maxAge = opts?.maxAgeMs ?? 15 * 60 * 1000;

  if (existsSync(cachePath)) {
    const { ts, data } = JSON.parse(readFileSync(cachePath, "utf8")) as {
      ts: number;
      data: DatetimeAvailabilityResponse;
    };
    if (Date.now() - ts < maxAge) return data;
  }

  const url = `${BASE}/api/athletic-fields?datetime=${date}+${time}`;
  const data = await get<DatetimeAvailabilityResponse>(url);
  writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

/**
 * Returns full per-slot permit detail for a field over a 7-day window.
 * Cache: 30 minutes (availability can change as permits are issued).
 */
export async function getFieldDetail(
  systemId: string,
  date: string,
  opts?: { maxAgeMs?: number }
): Promise<FieldDetailResponse> {
  const cachePath = fieldDetailCachePath(systemId, date);
  const maxAge = opts?.maxAgeMs ?? 30 * 60 * 1000;

  if (existsSync(cachePath)) {
    const { ts, data } = JSON.parse(readFileSync(cachePath, "utf8")) as {
      ts: number;
      data: FieldDetailResponse;
    };
    if (Date.now() - ts < maxAge) return data;
  }

  const url = `${BASE}/api/athletic-fields?location=${encodeURIComponent(systemId)}&date=${date}`;
  const data = await get<FieldDetailResponse>(url);
  writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

/**
 * Normalizes a FieldDetailResponse into per-day availability summary.
 *
 * The API returns a flat map of unix-timestamp → slot info. We group by date
 * and compute: reserved slots, available slots, and whether the day is fully open.
 */
export function normalizeFieldDetail(
  field: FieldRecord,
  detail: FieldDetailResponse,
  dateRange: string[]
): FieldAvailability {
  const days: DayAvailability[] = dateRange.map((date) => {
    const closingTime = detail.close?.[date] ?? "20:00";
    const reservedSlots: PermitSlot[] = [];

    for (const [unixStr, slot] of Object.entries(detail.availability)) {
      const unix = Number(unixStr);
      const slotDate = new Date(unix * 1000)
        .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      if (slotDate !== date) continue;
      if (slot.in_season && (slot.is_issued || slot.num_pending_permits > 0)) {
        reservedSlots.push({ unix, ...slot });
      }
    }

    return {
      date,
      isAvailable: reservedSlots.length === 0,
      reservedSlots,
      availableSlots: TYPICAL_SLOTS_PER_DAY - reservedSlots.length,
      closingTime,
    };
  });

  return { field, days };
}

/**
 * High-level query: given a list of field records and a date range,
 * returns normalized availability for every field.
 *
 * Uses the bulk snapshot endpoint to filter to only fields worth querying
 * (those that appear reserved), then fetches detail for those.
 * Fields with no reservations across the range are returned as fully available
 * without an extra per-field call.
 */
export async function queryAvailability(
  fields: FieldRecord[],
  dateRange: string[],
  opts?: { delayMs?: number; onProgress?: (done: number, total: number) => void }
): Promise<FieldAvailability[]> {
  const delay = opts?.delayMs ?? 200;

  // One bulk snapshot call per date (midday) to find which fields have any
  // reservation at the snapshot instant. NOTE: a field free at this instant but
  // booked earlier/later the same day is treated as fully available here; only
  // fields reserved at the snapshot get a full per-slot detail fetch below.
  const reservedByDate = new Map<string, Set<string>>();
  for (let i = 0; i < dateRange.length; i++) {
    const date = dateRange[i];
    const snap = await getReservedIds(date, SNAPSHOT_TIME);
    reservedByDate.set(date, new Set(snap.l));
    if (i < dateRange.length - 1) await new Promise((r) => setTimeout(r, delay));
  }

  // Fields that appear reserved on at least one day need detailed fetch
  const needsDetail = fields.filter((f) =>
    dateRange.some((d) => reservedByDate.get(d)?.has(f.system))
  );

  // For fields never reserved: return as fully available without an API call
  const neverReserved = fields.filter(
    (f) => !needsDetail.some((n) => n.system === f.system)
  );

  const results: FieldAvailability[] = neverReserved.map((field) => ({
    field,
    days: dateRange.map((date) => ({
      date,
      isAvailable: true,
      reservedSlots: [],
      availableSlots: TYPICAL_SLOTS_PER_DAY,
      closingTime: "20:00",
    })),
  }));

  // Fetch detail for fields with at least one reservation
  for (let i = 0; i < needsDetail.length; i++) {
    const field = needsDetail[i];
    const detail = await getFieldDetail(field.system, dateRange[0]);
    results.push(normalizeFieldDetail(field, detail, dateRange));
    opts?.onProgress?.(i + 1, needsDetail.length);
    if (i < needsDetail.length - 1) await new Promise((r) => setTimeout(r, delay));
  }

  // Sort by system ID for stable output
  results.sort((a, b) => a.field.system.localeCompare(b.field.system));
  return results;
}

/** Generate an array of YYYY-MM-DD strings for [startDate, startDate+days) */
export function dateRange(startDate: string, days: number): string[] {
  const out: string[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
