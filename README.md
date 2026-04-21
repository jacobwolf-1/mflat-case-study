# NYC Parks Field Availability

Search field and court permit availability across NYC parks. Data comes from the public NYC Parks permit workflow — no private APIs or credentials required.

## One-line setup

```bash
npm install && node scripts/poc.mjs && npm run dev
```

Then open **http://localhost:3000**.

The `node scripts/poc.mjs` step builds the field catalog (~30 seconds, one time only). After that, all catalog reads are instant from disk.

## How to run

```bash
# Install dependencies
npm install

# Build the field catalog (required once; re-run to refresh)
node scripts/poc.mjs

# Start the app
npm run dev
```

Open http://localhost:3000, choose a sport and date range, click Search.

## How caching works

There are two layers of caching, both stored under `data/cache/`:

| Cache | Location | TTL |
|-------|----------|-----|
| Field catalog | `data/cache/fields_catalog.json` | Permanent until manually deleted |
| Availability snapshots | `data/cache/availability/snapshot_*.json` | 15 minutes |
| Per-field slot detail | `data/cache/availability/fields/*.json` | 30 minutes |

**Field catalog** — built by sweeping 182 vector tiles from `maps.nycgovparks.org` at zoom 13. Contains 5,208 permittable fields with sport type, surface, hours, and the system ID used in all API calls. Rebuild monthly or after major Parks system updates:

```bash
rm data/cache/fields_catalog.json && node scripts/poc.mjs
```

**Availability data** — fetched live from the NYC Parks permit API on each search. Short TTLs keep results fresh without hammering the server on repeated identical queries.

## Why direct requests, not browser automation

After inspecting the permit map's network traffic, we found two fully public JSON endpoints:

```
GET https://www.nycgovparks.org/api/athletic-fields?datetime=YYYY-MM-DD+H:mm
GET https://www.nycgovparks.org/api/athletic-fields?location=SYSTEM_ID&date=YYYY-MM-DD
```

Both respond to plain HTTP GET with no session, cookies, or auth. A real browser UA header is required (the HTML page blocks headless requests, but the API endpoints do not). Playwright was used only for initial network traffic discovery.

Direct requests are simpler, faster, and fully cacheable without a running browser process.

See `docs/data-access-plan.md` for endpoint schemas, risk analysis, and full technical details.

## Architecture

```
app/
  page.tsx                    # client-side search UI (form + table + expandable rows)
  api/availability/route.ts   # returns field table data for a sport + date range
  api/field-detail/route.ts   # returns slot-level detail for one field
lib/
  field-catalog.ts            # builds/loads the field catalog from vector tiles
  availability-client.ts      # wraps the two public NYC Parks API endpoints
  types.ts                    # shared TypeScript types
scripts/
  poc.mjs                     # standalone CLI proof-of-concept (also seeds the catalog)
data/cache/                   # all disk caches live here (gitignored)
docs/
  data-access-plan.md         # findings, endpoint schemas, risks, next steps
```

## Known limitations

- **Noon snapshot only** — the table shows "Busy" if a field has a permit at noon. Fields with only morning or evening reservations appear as "Free." Expand a row to see the full day's time slots.
- **7-day detail window** — the per-field detail endpoint covers a fixed 7-day window from the requested start date.
- **Max 200 fields shown** — results are capped to keep the table usable. Fully-free fields sort to the top.
- **Catalog staleness** — field metadata changes infrequently; rebuild the catalog monthly or when the permit season changes.
- **No published rate limits** — Parks doesn't publish rate limit info. The app adds 50–200 ms delays between batches and caches aggressively.
- **Local only** — no auth, no database, no deployment config. Runs on localhost only.

## Demo query

Soccer fields — next 5 days:

```
Sport:      Soccer
Start date: today
Days:       5
```

Expected: ~266 soccer fields shown. Fully-free fields at the top. Click any row to expand and see permit-holder names and exact 30-minute time slots.
