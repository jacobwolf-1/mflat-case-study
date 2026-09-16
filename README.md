# NYC Parks Field Availability

[![CI](https://github.com/jacobwolf-1/mflat-case-study/actions/workflows/ci.yml/badge.svg)](https://github.com/jacobwolf-1/mflat-case-study/actions/workflows/ci.yml)
![Next.js 16](https://img.shields.io/badge/Next.js-16-black.svg)
![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178c6.svg)

**Next.js 16 (App Router) · TypeScript · React 19 · reverse-engineered public-endpoint integration with disk caching.**

Search field and court permit availability across NYC parks. This MVP uses the public NYC Parks permit workflow only — no private APIs or credentials required. The current UI supports short-range searches (up to 7 days) and shows a one-screen comparison table with expandable slot-level detail.

> 📷 **Screenshot placeholder (MVP — capture pending).** Add `docs/media/table.png`:
> the comparison table for a sport + date range with one row expanded to
> slot-level detail. Reproduce the exact view with the "Demo query" below.

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
  data-access-plan.md         # findings, endpoint schemas, risks, and implementation notes
```

## Tests

```bash
npm test          # node:test unit suite (no extra dependencies)
npm run lint      # eslint (eslint-config-next)
npx tsc --noEmit  # type-check
```

The unit suite (`tests/`) covers query validation, date-range generation,
availability normalization (in-season / issued / pending logic), and the
disk-cache TTL behavior. CI runs lint, type-check, tests, and a production build
on every push.

## Known limitations

- **Search range is capped at 7 days** — the current UI/API intentionally limit the date range for a fast MVP.
- **Daily status uses a noon snapshot** — the table marks a field as busy if it appears reserved at noon. A field with only morning or evening reservations may still appear free in the top-level table; expand a row for slot-level detail.
- **Slot counts are approximate** — the "X/24 slots free" figure assumes a typical 24-slot day (8:00 AM–8:00 PM in 30-minute increments); a field that closes earlier has fewer real slots than that denominator implies. The expanded row always lists the actual reserved slots.
- **Max 200 fields shown** — results are capped to keep the table usable. Fields with conflicts are prioritized near the top so the most decision-relevant rows are visible first.
- **Catalog staleness** — field metadata changes infrequently; rebuild the catalog when needed.
- **No published rate limits** — caching and short delays are used to stay polite to the public site.
- **Local-only MVP** — no auth, DB, or deployment config.

## Demo query

Soccer fields — next 5 days:

```
Sport:      Soccer
Start date: today
Days:       5
```

Expected: ~266 soccer fields total, with up to 200 shown in the table. Fields with conflicts are prioritized near the top. Click any row to expand and see exact 30-minute slots and permit-holder names.
