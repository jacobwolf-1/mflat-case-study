import { type NextRequest } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { buildCatalog } from "@/lib/field-catalog";
import { getReservedIds } from "@/lib/availability-client";
import type { SportCode } from "@/lib/types";

export const dynamic = "force-dynamic";

// Max fields to return so the table stays usable
const MAX_ROWS = 200;
const MAX_DAYS = 7;

function dateRange(start: string, days: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const sport = searchParams.get("sport") as SportCode | null;
  const date = searchParams.get("date");
  const rawDays = searchParams.get("days") ?? "3";
  const days = Number(rawDays);

  if (!sport || !date) {
    return Response.json({ error: "Missing required params: sport, date" }, { status: 400 });
  }

  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return Response.json(
      { error: `Invalid days value. Expected an integer between 1 and ${MAX_DAYS}.` },
      { status: 400 }
    );
  }

  // Require the catalog to be pre-built (run `node scripts/poc.mjs` first)
  const catalogPath = path.resolve(process.cwd(), "data/cache/fields_catalog.json");
  if (!existsSync(catalogPath)) {
    return Response.json(
      {
        error: "Field catalog not built yet. Run: node scripts/poc.mjs SCR 2026-04-22 1",
        hint: "This seeds the tile catalog (~30s). Subsequent runs are instant.",
      },
      { status: 503 }
    );
  }

  try {
    const catalog = await buildCatalog(); // loads from disk cache
    const sportFields = Object.values(catalog).filter(
      (f) => f.primary_sport === sport && f.permitable === "YES"
    );

    if (sportFields.length === 0) {
      return Response.json({ error: `No fields found for sport "${sport}"` }, { status: 404 });
    }

    const dates = dateRange(date, days);

    // One snapshot call per date (noon NYC time). Results are disk-cached 15 min.
    const snapshots = await Promise.all(
      dates.map((d) => getReservedIds(d, "12:00"))
    );

    const reservedSets = snapshots.map((s) => new Set(s.l));

    // Build per-field daily status from snapshots
    type DayStatus = { date: string; status: "free" | "busy" };
    type Row = {
      system: string;
      name: string;
      surface_type: string;
      close_at_dusk: string;
      opening_time: string;
      permit_parent: string;
      days: DayStatus[];
      freeDayCount: number;
    };

    const rows: Row[] = sportFields.map((f) => {
      const days: DayStatus[] = dates.map((d, i) => ({
        date: d,
        status: reservedSets[i].has(f.system) ? "busy" : "free",
      }));
      return {
        system: f.system,
        name: f.name,
        surface_type: f.surface_type,
        close_at_dusk: f.close_at_dusk,
        opening_time: f.opening_time,
        permit_parent: f.permit_parent,
        days,
        freeDayCount: days.filter((d) => d.status === "free").length,
      };
    });

    // Sort: partial (some busy + some free) → fully reserved → fully free.
    // This ensures real reservations are visible and not cut off by the cap.
    function sortKey(r: Row): number {
      const busyDays = r.days.length - r.freeDayCount;
      if (busyDays > 0 && r.freeDayCount > 0) return 0; // partial: most interesting
      if (busyDays > 0) return 1;                         // fully reserved
      return 2;                                            // fully free
    }
    rows.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka !== kb ? ka - kb : a.system.localeCompare(b.system);
    });

    const total = rows.length;
    const limited = rows.slice(0, MAX_ROWS);

    return Response.json({
      sport,
      dates,
      total,
      shown: limited.length,
      fields: limited,
      note: "Status = busy if field appears in the noon availability snapshot. Expand a row for full day detail.",
    });
  } catch (err) {
    console.error("[availability]", err);
    return Response.json({ error: "Internal error", detail: String(err) }, { status: 500 });
  }
}
