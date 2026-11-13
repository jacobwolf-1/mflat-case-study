# NYC Field Finder

I built a comparison table for NYC Parks field availability, with boroughs, park names and expandable permit details.

Built as a time-boxed engineering case study (April 2026), later cleaned up and extended.

## The problem

League organizers and coaches need to find a field that fits their sport, location and schedule. The official NYC Parks permit map makes comparing several fields across several days awkward: I wanted to bring those choices into one table, then inspect the exact reservations before pursuing a permit.

![Soccer availability for October 7–9, 2026, with Bushwick Playground expanded to show reserved slots and permit holders](docs/media/table.png)

## What I built

- I reverse-engineered the permit map's vector tiles into a catalog of about **5,200 fields**, then added boroughs and an exact `gispropnum` join to [NYC Open Data park names](https://data.cityofnewyork.us/Recreation/Parks-Properties/enfh-gkve).
- I found the **public JSON endpoints** behind the map and built a query flow that costs **four bulk calls per day**, regardless of field count. Slot detail is fetched only when a row is expanded.
- I added **disk caching with TTLs** (15 minutes for snapshots, 30 minutes for detail), serialized availability requests with delays, and shared the data-access code between the Next.js app and exploration CLI.

## Quick start

**Node 22.6+** is required for `--experimental-strip-types`.

```bash
npm install && npm run catalog && npm run dev
```

Open [localhost:3000](http://localhost:3000). Choose Soccer and three days, then expand a field.

Catalog setup fetches metadata only: 182 tiles in small batches and one park-name lookup. Cold-build time depends on NYC Parks latency; subsequent runs reuse the cache. To refresh metadata: `npm run catalog -- --refresh`.

The original exploration CLI now imports the same library: `npm run poc -- SCR 2026-10-08 3`. It prints a short summary and saves JSON under `data/cache/`; an optional field ID fetches that field's slot detail.

## Architecture

**Next.js App Router · TypeScript · React**

```text
app/page.tsx                  Search → comparison table → expanded slots
app/api/availability/         Validated query → four snapshots per date
app/api/field-detail/         Validated field/date → weekly permit detail
lib/field-catalog.ts          Vector-tile catalog + cached park-name join
lib/availability-client.ts    Snapshot summaries, slot normalization, caching
lib/validation.ts            Shared input validation
scripts/catalog.mjs          Catalog-only setup and refresh
```

All caches live in gitignored `data/cache/`. The field catalog and park-name lookup are reused until explicitly refreshed. Requests identify themselves as `NYCFieldFinder/0.1`; no browser automation or credentials are needed. [Data-access notes](docs/data-access-plan.md) cover endpoint schemas, caching and the verified park-name join.
