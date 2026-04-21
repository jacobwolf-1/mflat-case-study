/**
 * Proof-of-concept: fetch availability for one sport type over a short date range.
 *
 * Usage:
 *   node scripts/poc.mjs [sport] [start-date] [days]
 *
 * Examples:
 *   node scripts/poc.mjs                         # soccer, next 3 days
 *   node scripts/poc.mjs SCR 2026-04-22 5        # soccer for 5 days
 *   node scripts/poc.mjs BKB 2026-04-22 3        # basketball
 *   node scripts/poc.mjs BSB 2026-04-28 7        # baseball
 *
 * Sport codes: SCR=Soccer BSB=Baseball SFB=Softball BKB=Basketball
 *              FTB=Football HDB=Handball VLB=Volleyball CRK=Cricket
 */

import { createRequire } from "module";
import { gunzipSync } from "zlib";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const require = createRequire(ROOT + "/package.json");
const { VectorTile } = require("@mapbox/vector-tile");
const PbfMod = require("pbf");
const Pbf = PbfMod.default ?? PbfMod;

// ── config from args ──────────────────────────────────────────────────────────
const SPORT = process.argv[2] ?? "SCR";
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const START_DATE =
  process.argv[3] ?? tomorrow.toISOString().slice(0, 10);
const DAYS = Number(process.argv[4] ?? 3);

const SPORT_NAMES = {
  SCR: "Soccer", BSB: "Baseball", SFB: "Softball", BKB: "Basketball",
  FTB: "Football", HDB: "Handball", VLB: "Volleyball", CRK: "Cricket",
  BOC: "Bocce", NTB: "Netball", RBY: "Rugby", TRK: "Track and Field",
  TNS: "Tennis", MPPA: "Multi-purpose Play Area", HKY: "Hockey",
};

// ── helpers ───────────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Referer": "https://www.nycgovparks.org/permits/field-and-court/map", "Accept": "application/json" };
const BASE = "https://www.nycgovparks.org";

async function fetchJson(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function cacheGet(p, maxAgeMs = 30 * 60 * 1000) {
  if (!existsSync(p)) return null;
  const { ts, data } = JSON.parse(readFileSync(p, "utf8"));
  return Date.now() - ts < maxAgeMs ? data : null;
}
function cacheSet(p, data) { writeFileSync(p, JSON.stringify({ ts: Date.now(), data })); }

function dateRange(start, days) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ── field catalog (vector tile decode) ───────────────────────────────────────
function lonToX(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function latToY(lat, z) {
  const r = Math.PI / 180;
  return Math.floor(((1 - Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r)) / Math.PI) / 2) * 2 ** z);
}

async function loadCatalog(force = false) {
  const catalogPath = path.join(ROOT, "data/cache/fields_catalog.json");
  if (!force && existsSync(catalogPath)) {
    return JSON.parse(readFileSync(catalogPath, "utf8"));
  }

  console.log("Building field catalog from vector tiles (one-time, ~30s)...");
  const Z = 13;
  const minX = lonToX(-74.26, Z), maxX = lonToX(-73.70, Z);
  const minY = latToY(40.92, Z), maxY = latToY(40.49, Z);
  const total = (maxX - minX + 1) * (maxY - minY + 1);

  const fields = {};
  const tiles = [];
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      tiles.push([x, y]);

  let done = 0;
  for (let i = 0; i < tiles.length; i += 10) {
    const batch = tiles.slice(i, i + 10);
    await Promise.all(batch.map(async ([x, y]) => {
      try {
        const url = `https://maps.nycgovparks.org/athletic_facility/${Z}/${x}/${y}`;
        const resp = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://www.nycgovparks.org/" } });
        if (!resp.ok) return;
        let data = Buffer.from(await resp.arrayBuffer());
        if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
        const tile = new VectorTile(new Pbf(new Uint8Array(data)));
        const layer = tile.layers["athletic_facility_permitable"] ?? tile.layers["athletic_facility"];
        if (!layer) return;
        for (let j = 0; j < layer.length; j++) {
          const p = layer.feature(j).properties;
          if (p?.system && !fields[p.system]) fields[p.system] = p;
        }
      } catch { /* empty tile or network error */ }
      done++;
    }));
    process.stdout.write(`\r  tiles: ${done}/${total} — fields found: ${Object.keys(fields).length}   `);
    if (i + 10 < tiles.length) await new Promise(r => setTimeout(r, 50));
  }
  console.log();

  ensureDir(path.join(ROOT, "data/cache"));
  writeFileSync(catalogPath, JSON.stringify(fields, null, 2));
  console.log(`  Catalog saved: ${Object.keys(fields).length} fields`);
  return fields;
}

// ── availability queries ──────────────────────────────────────────────────────
async function getReservedIds(date, time = "9:00") {
  ensureDir(path.join(ROOT, "data/cache/availability"));
  const p = path.join(ROOT, `data/cache/availability/snapshot_${date}_${time.replace(":", "-")}.json`);
  const cached = cacheGet(p, 15 * 60 * 1000);
  if (cached) return cached;
  const data = await fetchJson(`${BASE}/api/athletic-fields?datetime=${date}+${time}`);
  cacheSet(p, data);
  return data;
}

async function getFieldDetail(systemId, startDate) {
  ensureDir(path.join(ROOT, "data/cache/availability/fields"));
  const safe = systemId.replace(/[^a-zA-Z0-9-]/g, "_");
  const p = path.join(ROOT, `data/cache/availability/fields/${safe}_${startDate}.json`);
  const cached = cacheGet(p, 30 * 60 * 1000);
  if (cached) return cached;
  const data = await fetchJson(`${BASE}/api/athletic-fields?location=${encodeURIComponent(systemId)}&date=${startDate}`);
  cacheSet(p, data);
  return data;
}

function normalizeDay(date, detail) {
  const closingTime = detail.close?.[date] ?? "20:00";
  const reservedSlots = [];
  for (const [unixStr, slot] of Object.entries(detail.availability ?? {})) {
    const unix = Number(unixStr);
    const slotDate = new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (slotDate !== date) continue;
    if (slot.in_season && (slot.is_issued || slot.num_pending_permits > 0)) {
      reservedSlots.push({ unix, ...slot });
    }
  }
  return {
    date,
    isAvailable: reservedSlots.length === 0,
    reservedSlots,
    availableSlots: 24 - reservedSlots.length,
    closingTime,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const sportName = SPORT_NAMES[SPORT] ?? SPORT;
  const dates = dateRange(START_DATE, DAYS);

  console.log(`\nNYC Parks Field Availability — ${sportName} (${SPORT})`);
  console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log("─".repeat(60));

  // 1. Load field catalog
  const catalog = await loadCatalog();
  const allFields = Object.values(catalog);
  const sportFields = allFields.filter(f => f.primary_sport === SPORT && f.permitable === "YES");
  console.log(`\nFields matching sport "${sportName}": ${sportFields.length} / ${allFields.length} total`);

  if (sportFields.length === 0) {
    console.error(`No fields found for sport code "${SPORT}". Valid codes: ${Object.keys(SPORT_NAMES).join(", ")}`);
    process.exit(1);
  }

  // 2. Get reserved IDs for each date (bulk snapshot — one call per day)
  console.log("\nFetching daily availability snapshots...");
  const reservedByDate = new Map();
  for (let i = 0; i < dates.length; i++) {
    const snap = await getReservedIds(dates[i]);
    reservedByDate.set(dates[i], new Set(snap.l));
    process.stdout.write(`  ${dates[i]}: ${snap.l.length} reserved fields system-wide\n`);
    if (i < dates.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  // 3. Separate fields that need detail fetch from those that are fully free
  const needsDetail = sportFields.filter(f =>
    dates.some(d => reservedByDate.get(d)?.has(f.system))
  );
  const fullyFree = sportFields.filter(f =>
    !needsDetail.some(n => n.system === f.system)
  );

  console.log(`\n  ${fullyFree.length} fields have no reservations in this window (fully available)`);
  console.log(`  ${needsDetail.length} fields have at least one reservation — fetching details...`);

  // 4. Fetch per-field detail for fields with reservations
  const results = [];

  // Fully free fields
  fullyFree.forEach(field => {
    results.push({
      field,
      days: dates.map(date => ({
        date, isAvailable: true, reservedSlots: [], availableSlots: 24, closingTime: "20:00",
      })),
    });
  });

  // Fields with reservations
  for (let i = 0; i < needsDetail.length; i++) {
    const field = needsDetail[i];
    const detail = await getFieldDetail(field.system, dates[0]);
    results.push({ field, days: dates.map(d => normalizeDay(d, detail)) });
    if (i < needsDetail.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  results.sort((a, b) => a.field.system.localeCompare(b.field.system));

  // 5. Print normalized results
  console.log("\n" + "─".repeat(60));
  console.log(`RESULTS: ${sportName} field availability`);
  console.log("─".repeat(60));

  for (const { field, days } of results) {
    const availDates = days.filter(d => d.isAvailable).map(d => d.date);
    const partialDates = days.filter(d => !d.isAvailable && d.availableSlots > 0);
    const status = availDates.length === days.length ? "FULLY FREE" :
                   availDates.length === 0 ? "FULLY RESERVED" : "PARTIAL";

    console.log(`\n${field.name} [${field.system}]`);
    console.log(`  Surface: ${field.surface_type} | Opens: ${field.opening_time} | Lighted: ${field.close_at_dusk === "TRUE" ? "No" : "Yes"}`);
    for (const day of days) {
      const slots = day.isAvailable ? "All slots free" : `${day.availableSlots}/24 slots free`;
      const reserved = day.reservedSlots.length > 0
        ? ` (${[...new Set(day.reservedSlots.map(s => s.permit_holder).filter(Boolean))].join(", ")})`
        : "";
      console.log(`  ${day.date}: ${slots}${reserved}`);
    }
  }

  // 6. Summary
  const fullyAvail = results.filter(r => r.days.every(d => d.isAvailable));
  const partial = results.filter(r => r.days.some(d => d.isAvailable) && r.days.some(d => !d.isAvailable));
  const fullyReserved = results.filter(r => r.days.every(d => !d.isAvailable));

  console.log("\n" + "─".repeat(60));
  console.log(`SUMMARY: ${results.length} ${sportName} fields`);
  console.log(`  Fully available this window: ${fullyAvail.length}`);
  console.log(`  Partially available:         ${partial.length}`);
  console.log(`  Fully reserved:              ${fullyReserved.length}`);

  // Save JSON output
  const outPath = path.join(ROOT, "data/cache/poc_results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
