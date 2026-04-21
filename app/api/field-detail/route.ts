import { type NextRequest } from "next/server";
import { getFieldDetail } from "@/lib/availability-client";
import { normalizeFieldDetail } from "@/lib/availability-client";
import type { FieldRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

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
  const system = searchParams.get("system");
  const date = searchParams.get("date");
  const days = Math.min(Number(searchParams.get("days") ?? "3"), 7);

  if (!system || !date) {
    return Response.json({ error: "Missing required params: system, date" }, { status: 400 });
  }

  try {
    const detail = await getFieldDetail(system, date);
    const dates = dateRange(date, days);

    // Build a minimal FieldRecord stub — we only need system for normalization
    const stub: FieldRecord = {
      system,
      name: detail.fieldName ?? system,
      primary_sport: "",
      sports: "",
      surface_type: "",
      close_at_dusk: "FALSE",
      opening_time: "8:00 AM",
      permit_parent: "",
      permitable: "YES",
    };

    const normalized = normalizeFieldDetail(stub, detail, dates);

    // Serialize each day's slots with a human-readable time
    const result = normalized.days.map((day) => ({
      date: day.date,
      isAvailable: day.isAvailable,
      closingTime: day.closingTime,
      availableSlots: day.availableSlots,
      reservedSlots: day.reservedSlots.map((s) => ({
        time: new Date(s.unix * 1000).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York",
        }),
        unix: s.unix,
        is_issued: s.is_issued,
        permit_holder: s.permit_holder,
        permit_type: s.permit_type,
        num_pending_permits: s.num_pending_permits,
      })),
    }));

    return Response.json({ system, fieldName: detail.fieldName, days: result });
  } catch (err) {
    console.error("[field-detail]", err);
    return Response.json({ error: "Internal error", detail: String(err) }, { status: 500 });
  }
}
