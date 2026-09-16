import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAvailabilityQuery, isValidDateString, MAX_DAYS } from "../lib/validation.ts";
import {
  dateRange,
  normalizeFieldDetail,
  getReservedIds,
} from "../lib/availability-client.ts";

// ── Input validation ────────────────────────────────────────────────────────

test("parseAvailabilityQuery rejects missing sport or date", () => {
  assert.equal(parseAvailabilityQuery({ sport: null, date: "2026-04-22", days: "3" }).ok, false);
  assert.equal(parseAvailabilityQuery({ sport: "SCR", date: null, days: "3" }).ok, false);
});

test("parseAvailabilityQuery rejects malformed dates", () => {
  for (const date of ["2026-13-40", "2026-4-2", "04-22-2026", "not-a-date", "2026-02-30"]) {
    const r = parseAvailabilityQuery({ sport: "SCR", date, days: "3" });
    assert.equal(r.ok, false, `expected ${date} to be rejected`);
  }
});

test("parseAvailabilityQuery enforces the day bound and integer-ness", () => {
  for (const days of ["0", "8", "2.5", "abc", "-1"]) {
    const r = parseAvailabilityQuery({ sport: "SCR", date: "2026-04-22", days });
    assert.equal(r.ok, false, `expected days=${days} to be rejected`);
  }
  assert.equal(parseAvailabilityQuery({ sport: "SCR", date: "2026-04-22", days: String(MAX_DAYS) }).ok, true);
});

test("parseAvailabilityQuery defaults missing days to 3 and returns typed value", () => {
  const r = parseAvailabilityQuery({ sport: "SCR", date: "2026-04-22", days: null });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { sport: "SCR", date: "2026-04-22", days: 3 });
});

test("isValidDateString accepts real dates and rejects impossible ones", () => {
  assert.equal(isValidDateString("2026-04-22"), true);
  assert.equal(isValidDateString("2026-02-29"), false); // 2026 is not a leap year
  assert.equal(isValidDateString("2024-02-29"), true); // 2024 is
});

// ── Date ranges ───────────────────────────────────────────────────────────────

test("dateRange produces consecutive UTC dates and honors count", () => {
  assert.deepEqual(dateRange("2026-04-22", 3), ["2026-04-22", "2026-04-23", "2026-04-24"]);
  assert.deepEqual(dateRange("2026-04-22", 1), ["2026-04-22"]);
});

test("dateRange crosses month and year boundaries", () => {
  assert.deepEqual(dateRange("2026-01-30", 3), ["2026-01-30", "2026-01-31", "2026-02-01"]);
  assert.deepEqual(dateRange("2026-12-31", 2), ["2026-12-31", "2027-01-01"]);
});

// ── Availability normalization ────────────────────────────────────────────────

function slot(overrides = {}) {
  return {
    in_season: true,
    permit_is_for_overlapping_field: false,
    num_pending_permits: 0,
    permit_number: null,
    is_issued: false,
    permit_holder: null,
    permit_type: null,
    ...overrides,
  };
}

// noon Eastern on a given date -> unix seconds (April is EDT, UTC-4)
function noonEtUnix(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);
}

test("normalizeFieldDetail counts only in-season issued/pending slots as reserved", () => {
  const field = { system: "M071-1", name: "Test Field", primary_sport: "SCR" };
  const detail = {
    fieldName: "Test Field",
    close: { "2026-04-22": "20:15" },
    availability: {
      [noonEtUnix(2026, 4, 22)]: slot({ is_issued: true }), // reserved
      [noonEtUnix(2026, 4, 22) + 1800]: slot({ num_pending_permits: 1 }), // reserved (pending)
      [noonEtUnix(2026, 4, 22) + 3600]: slot({ is_issued: false }), // free
      [noonEtUnix(2026, 4, 22) + 5400]: slot({ in_season: false, is_issued: true }), // not in season -> free
      [noonEtUnix(2026, 4, 23)]: slot({ is_issued: true }), // reserved, next day
    },
  };

  const result = normalizeFieldDetail(field, detail, ["2026-04-22", "2026-04-23", "2026-04-24"]);
  const [d22, d23, d24] = result.days;

  assert.equal(d22.reservedSlots.length, 2);
  assert.equal(d22.availableSlots, 22); // 24 typical - 2 reserved
  assert.equal(d22.isAvailable, false);
  assert.equal(d22.closingTime, "20:15");

  assert.equal(d23.reservedSlots.length, 1);
  assert.equal(d23.availableSlots, 23);

  // A day in range with no slot data is fully available and uses the default close time
  assert.equal(d24.reservedSlots.length, 0);
  assert.equal(d24.isAvailable, true);
  assert.equal(d24.availableSlots, 24);
  assert.equal(d24.closingTime, "20:00");
});

// ── Caching behavior ──────────────────────────────────────────────────────────

test("getReservedIds serves from disk cache within TTL and refetches when stale", async () => {
  const realFetch = globalThis.fetch;
  const prevCwd = process.cwd();
  const tmp = mkdtempSync(join(tmpdir(), "mflat-cache-"));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ dusk: "19:30", l: ["FIELD-1"] }) };
  };
  process.chdir(tmp);
  try {
    const first = await getReservedIds("2026-04-22", "12:00");
    assert.deepEqual(first.l, ["FIELD-1"]);
    assert.equal(calls, 1);

    // Second call within TTL: no new network call
    await getReservedIds("2026-04-22", "12:00");
    assert.equal(calls, 1);

    // maxAgeMs 0 forces the cached entry to be treated as stale -> refetch
    await getReservedIds("2026-04-22", "12:00", { maxAgeMs: 0 });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});
