# Data Access Plan — NYC Parks Field Availability

## What We Found

The NYC Parks public permit map (`nycgovparks.org/permits/field-and-court/map`) renders availability data by calling two undocumented but fully public JSON endpoints. Both respond to plain `GET` requests with no authentication, cookies, or session required.

We confirmed this by loading the permit map page with a real browser UA (Playwright for discovery, curl for verification), intercepting network traffic, and reading the 43 KB of inline JavaScript that drives the map.

---

## Confirmed Public Endpoints

### 1. Bulk snapshot — all reserved fields at a given datetime

```
GET https://www.nycgovparks.org/api/athletic-fields?datetime=YYYY-MM-DD+H:mm
```

**Response shape:**
```json
{
  "dusk": "20:15",
  "l": ["M071-18-SOCCER-1", "Q005-05-BASKETBALL-1", ...]
}
```

- `dusk` — closing time (HH:MM, 24h) for that day  
- `l` — array of **system IDs** that are reserved at the queried moment. All IDs **not** in this list are available.

**Usage:** Call once per date (e.g., at 9:00 AM) to determine which fields are booked at all that day. This is the efficient sweep call.

### 2. Per-field weekly detail

```
GET https://www.nycgovparks.org/api/athletic-fields?location=SYSTEM_ID&date=YYYY-MM-DD
```

**Response shape:**
```json
{
  "fieldName": "101st St-Soccer-04 C",
  "close": { "2026-04-22": "20:15", ... },
  "availability": {
    "1776862800": {
      "in_season": true,
      "permit_is_for_overlapping_field": false,
      "num_pending_permits": 0,
      "permit_number": 911496,
      "is_issued": true,
      "permit_holder": "BASIS Independent Manhattan",
      "permit_type": "Special Event"
    },
    ...
  }
}
```

- Keys of `availability` are Unix timestamps (30-minute slots).
- A slot is **reserved** if `is_issued === true` OR `num_pending_permits > 0`.
- `close` gives closing time per calendar date.
- The date window covers 7 days starting at `date`.

**Usage:** Call for fields with at least one reservation to get slot-level detail. Skip for fully-free fields to avoid unnecessary requests.

---

## Field Catalog Source

**Field metadata does not come from these availability endpoints.** Field names, sport types, surface types, and locations are stored in MapLibre GL vector tiles:

```
https://maps.nycgovparks.org/athletic_facility/{z}/{x}/{y}
```

- Format: MapBox Vector Tiles (protobuf). Responses are uncompressed when fetched without `Accept-Encoding: gzip`.
- Source layer name: `athletic_facility_permitable` (permittable fields only; falls back to `athletic_facility`).
- **Zoom 13** covers all of NYC in 182 tiles. Each tile can be decoded with `@mapbox/vector-tile` + `pbf`.

**Verified catalog size:** 5,208 unique permittable fields across all five boroughs.

### Field record schema (from tile properties)

| Field | Example | Notes |
|-------|---------|-------|
| `system` | `M071-18-SOCCER-1` | Primary key used in all API calls |
| `name` | `Soccer-01` | Short display name from Parks data |
| `primary_sport` | `SCR` | Sport code; see mapping below |
| `sports` | `"4"` | Encoded multi-sport value (not human-readable codes; use `primary_sport` for filtering) |
| `surface_type` | `Synthetic - Large/Full` | Grass, Natural, Asphalt, Turf, etc. |
| `close_at_dusk` | `TRUE` | If `TRUE`, field closes at dusk, not a fixed time |
| `opening_time` | `8:00 AM` | Fixed open time |
| `permit_parent` | `M071` | Park GIS ID |
| `permitable` | `YES` | Filter to `YES` to match the permit workflow |

### Sport codes

| Code | Sport | Code | Sport |
|------|-------|------|-------|
| SCR | Soccer | BSB | Baseball |
| SFB | Softball | BKB | Basketball |
| FTB | Football | HDB | Handball |
| HKY | Hockey | VLB | Volleyball |
| CRK | Cricket | BOC | Bocce |
| TRK | Track and Field | NTB | Netball |
| RBY | Rugby | MPPA | Multi-purpose Play Area |
| TNS | Tennis | | |

---

## Recommended Architecture

```
scripts/poc.mjs              # runnable POC (works today)
lib/field-catalog.ts         # builds + caches catalog from vector tiles
lib/availability-client.ts   # wraps the two API endpoints, adds disk cache
lib/types.ts                 # shared TypeScript types
data/cache/
  fields_catalog.json        # tile-decoded catalog (build once, refresh monthly)
  availability/
    snapshot_YYYY-MM-DD.json # bulk reserved-ID list (15 min TTL)
    fields/SYSID_DATE.json   # per-field detail (30 min TTL)
```

### Query flow

1. **On startup / once per month:** Sweep 182 vector tiles → write `fields_catalog.json`.
2. **Per search request:**
   a. Filter catalog by `primary_sport === sportCode && permitable === "YES"`.
   b. For each date in range: `GET /api/athletic-fields?datetime={date}+9:00` → reserved ID set.
   c. Fields not in any reserved set → return as fully available (no further calls).
   d. Fields appearing reserved → `GET /api/athletic-fields?location={id}&date={start}` for slot-level detail.
3. **Normalize** → `FieldAvailability[]` (field record + per-day slot summary).

This minimizes API calls: typically 1 call per date day + 1 call per field with a reservation (not per field total).

---

## Risks and Limitations

| Risk | Severity | Notes |
|------|----------|-------|
| Endpoints are undocumented | Medium | No SLA or change notice. The page JS references them directly so they're unlikely to disappear, but the shape could change. |
| Bot detection on the main page | Low | The `/api/athletic-fields` endpoints do **not** block headless requests. The HTML page does (403 without a real UA). Use a real UA on all requests. |
| Rate limits unknown | Low | We've not hit any. Use 50–200 ms delays between batches and cache aggressively. |
| `sports` field is not human-readable codes | Low | The tile's `sports` property appears to be a bitmask, not sport code strings. Filter by `primary_sport` instead. |
| System IDs ≠ sport in all cases | Low | Some multi-use fields have `primary_sport=SCR` but system IDs with `FOOTBALL` in the name. This is a data inconsistency in Parks' own system, not a scraping artifact. |
| Catalog staleness | Low | Fields are added/removed infrequently. Refreshing the catalog weekly or monthly is sufficient. |
| 7-day window on per-field detail | Low | Endpoint 2 always returns 7 days from `date`. For ranges > 7 days, paginate by calling with the next start date. |
| `available_slots` count is approximate | Low | We estimate 24 × 30-min slots per day; actual hours vary by field and season. The `close` object gives precise per-date closing times. |

---

## What to Build Next

1. **Next.js route handler** wrapping `availability-client.ts` — thin JSON API for the UI.
2. **Search UI** — sport dropdown, date-range picker, results table (available/partial/reserved).
3. **Background catalog refresh** — cron or on-demand rebuild of `fields_catalog.json`.
4. **Pagination** — for date ranges > 7 days, chain calls to endpoint 2.

---

## How to Run the POC

```bash
# First run (builds tile catalog ~30s, then fetches live data)
node scripts/poc.mjs SCR 2026-04-22 3

# Subsequent runs are fast (catalog and availability are cached)
node scripts/poc.mjs BKB 2026-04-25 5   # basketball
node scripts/poc.mjs BSB 2026-04-22 7   # baseball

# Force-refresh the catalog
rm data/cache/fields_catalog.json && node scripts/poc.mjs SCR
```

Output: per-field availability summary + `data/cache/poc_results.json` with full normalized JSON.
