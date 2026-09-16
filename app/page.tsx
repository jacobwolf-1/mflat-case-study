"use client";

import { useState, useTransition } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

const SPORTS = [
  { code: "SCR", label: "Soccer" },
  { code: "BSB", label: "Baseball" },
  { code: "SFB", label: "Softball" },
  { code: "BKB", label: "Basketball" },
  { code: "FTB", label: "Football" },
  { code: "HDB", label: "Handball" },
  { code: "VLB", label: "Volleyball" },
  { code: "CRK", label: "Cricket" },
  { code: "TRK", label: "Track and Field" },
  { code: "BOC", label: "Bocce" },
  { code: "NTB", label: "Netball" },
  { code: "RBY", label: "Rugby" },
  { code: "HKY", label: "Hockey" },
] as const;

type DayStatus = { date: string; status: "free" | "busy" };
type FieldRow = {
  system: string;
  name: string;
  surface_type: string;
  close_at_dusk: string;
  opening_time: string;
  permit_parent: string;
  days: DayStatus[];
  freeDayCount: number;
};
type AvailabilityResponse = {
  sport: string;
  dates: string[];
  total: number;
  shown: number;
  fields: FieldRow[];
  note: string;
  error?: string;
};
type SlotInfo = {
  time: string;
  unix: number;
  is_issued: boolean;
  permit_holder: string | null;
  permit_type: string | null;
  num_pending_permits: number;
};
type DetailDay = {
  date: string;
  isAvailable: boolean;
  closingTime: string;
  availableSlots: number;
  reservedSlots: SlotInfo[];
};
type DetailResponse = { system: string; fieldName: string; days: DetailDay[]; error?: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function fmtDayOfWeek(iso: string) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: "free" | "busy" }) {
  if (status === "free")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
        ✓ Free
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
      ✗ Busy
    </span>
  );
}

function SlotRow({ slot }: { slot: SlotInfo }) {
  const label = slot.is_issued
    ? slot.permit_holder ?? "Reserved"
    : `Pending (${slot.num_pending_permits})`;
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-20 shrink-0 font-mono text-gray-500">{slot.time}</span>
      <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{label}</span>
      {slot.permit_type && (
        <span className="text-gray-400">{slot.permit_type}</span>
      )}
    </div>
  );
}

function DetailPanel({
  system,
  date,
  days,
}: {
  system: string;
  date: string;
  days: number;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  async function load() {
    if (fetched) return;
    setLoading(true);
    setFetched(true);
    try {
      const res = await fetch(
        `/api/field-detail?system=${encodeURIComponent(system)}&date=${date}&days=${days}`
      );
      setData(await res.json());
    } catch {
      setData({ system, fieldName: system, days: [], error: "Failed to load" });
    } finally {
      setLoading(false);
    }
  }

  // Auto-fetch on mount
  if (!fetched) load();

  if (loading)
    return (
      <div className="px-4 py-3 text-xs text-gray-400">Loading detail…</div>
    );
  if (!data || data.error)
    return (
      <div className="px-4 py-3 text-xs text-red-500">
        {data?.error ?? "No data"}
      </div>
    );

  return (
    <div className="grid gap-4 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.days.map((day) => (
        <div key={day.date} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-gray-800">
              {fmtDayOfWeek(day.date)} {fmtDate(day.date)}
            </span>
            {day.isAvailable ? (
              <span className="text-xs font-medium text-emerald-600">All slots free</span>
            ) : (
              <span className="text-xs text-gray-500">
                {day.availableSlots}/24 slots free
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 mb-2">Closes {day.closingTime}</div>
          {day.reservedSlots.length === 0 ? (
            <p className="text-xs text-emerald-600">No reservations</p>
          ) : (
            <div className="flex flex-col gap-1">
              {day.reservedSlots.map((s) => (
                <SlotRow key={s.unix} slot={s} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FieldTableRow({
  field,
  dates,
  days,
  startDate,
}: {
  field: FieldRow;
  dates: string[];
  days: number;
  startDate: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className={`cursor-pointer border-b border-gray-100 text-sm transition-colors hover:bg-gray-50 ${
          expanded ? "bg-blue-50 hover:bg-blue-50" : ""
        }`}
        onClick={() => setExpanded((e) => !e)}
      >
        <td className="py-2 pl-4 pr-3">
          <div className="font-medium text-gray-900">{field.name}</div>
          <div className="text-xs text-gray-400">{field.system}</div>
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 hidden sm:table-cell">
          {field.surface_type}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 hidden md:table-cell">
          {field.opening_time}
          {field.close_at_dusk === "TRUE" ? " – dusk" : ""}
        </td>
        {field.days.map((day) => (
          <td key={day.date} className="px-3 py-2 text-center">
            <StatusBadge status={day.status} />
          </td>
        ))}
        <td className="px-3 py-2 text-right text-xs text-gray-400">
          {expanded ? "▲" : "▼"}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 bg-white">
          <td colSpan={3 + dates.length + 2} className="p-0">
            <DetailPanel system={field.system} date={startDate} days={days} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [sport, setSport] = useState("SCR");
  const [date, setDate] = useState(todayStr());
  const [days, setDays] = useState(3);
  const [result, setResult] = useState<AvailabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/availability?sport=${sport}&date=${date}&days=${days}`
        );
        const json: AvailabilityResponse = await res.json();
        if (!res.ok || json.error) {
          setError(json.error ?? `HTTP ${res.status}`);
        } else {
          setResult(json);
        }
      } catch (err) {
        setError(String(err));
      }
    });
  }

  const sportLabel = SPORTS.find((s) => s.code === sport)?.label ?? sport;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold text-gray-900">
          NYC Parks Field Availability
        </h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Live data from the public NYC Parks permit workflow
        </p>
      </header>

      {/* Form */}
      <div className="border-b border-gray-200 bg-white px-4 py-4 sm:px-6">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">Sport</label>
            <select
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {SPORTS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">Start date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={todayStr()}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">Days</label>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {[1, 2, 3, 5, 7].map((n) => (
                <option key={n} value={n}>
                  {n} day{n > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {isPending ? "Loading…" : "Search"}
          </button>
        </form>
      </div>

      {/* Content */}
      <main className="px-4 py-6 sm:px-6">
        {/* Loading */}
        {isPending && (
          <div className="flex flex-col items-center gap-3 py-16 text-gray-400">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-blue-500" />
            <p className="text-sm">Fetching availability from NYC Parks…</p>
          </div>
        )}

        {/* Error */}
        {!isPending && error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-4">
            <p className="font-medium text-red-800">Error</p>
            <p className="mt-1 text-sm text-red-600">{error}</p>
            {error.includes("catalog") && (
              <p className="mt-2 font-mono text-xs text-red-500">
                node scripts/poc.mjs SCR {todayStr()} 1
              </p>
            )}
          </div>
        )}

        {/* Results */}
        {!isPending && result && (
          <>
            {/* Summary bar */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-gray-700">
                <span className="font-semibold">{result.total}</span> {sportLabel} fields
                {result.total > result.shown && (
                  <span className="ml-1 text-gray-400">
                    (showing {result.shown})
                  </span>
                )}
              </div>
              <div className="flex gap-4 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  Free at noon
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  Has noon reservation
                </span>
              </div>
            </div>

            {/* Empty state */}
            {result.fields.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                No {sportLabel} fields found in catalog.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                      <th className="py-3 pl-4 pr-3">Field</th>
                      <th className="px-3 py-3 hidden sm:table-cell">Surface</th>
                      <th className="px-3 py-3 hidden md:table-cell">Hours</th>
                      {result.dates.map((d) => (
                        <th key={d} className="px-3 py-3 text-center">
                          <span className="block">{fmtDayOfWeek(d)}</span>
                          <span className="block font-normal">{fmtDate(d)}</span>
                        </th>
                      ))}
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {result.fields.map((field) => (
                      <FieldTableRow
                        key={field.system}
                        field={field}
                        dates={result.dates}
                        days={days}
                        startDate={date}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Note */}
            <p className="mt-3 text-xs text-gray-400">{result.note}</p>
          </>
        )}

        {/* Idle state */}
        {!isPending && !result && !error && (
          <div className="py-16 text-center text-gray-400">
            <p className="text-sm">Choose a sport and date range above, then click Search.</p>
          </div>
        )}
      </main>
    </div>
  );
}
