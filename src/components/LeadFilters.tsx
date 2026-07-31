"use client";

// One button instead of nine dropdowns.
//
// The filter row had grown to six multi-selects, two selects, a checkbox and
// fourteen segment chips, wrapping onto four lines and pushing the actual leads
// off the screen on a phone. Same questions, folded behind a single control
// that says how many you've answered, with the answers shown as chips you can
// pull off one at a time.

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import MultiSelect from "@/components/MultiSelect";
import { MONTH_NAMES, MONTH_UNKNOWN } from "@/lib/categories";
import { BAND_GROUPS, OCCUPANCY_OPTIONS, VALUE_BANDS, type Occupancy } from "@/lib/valueBands";
import { DISTANCE_BANDS, type DistanceOrigin } from "@/lib/distance";
import {
  activeCount,
  buildOptions,
  emptyFilter,
  pruneZips,
  type LeadFilterState,
} from "@/lib/leadFilter";
import type { Lead } from "@/lib/types";

export default function LeadFilters({
  pool,
  value,
  onChange,
  size = "sm",
}: {
  /** The leads this page is working with; the option counts come from it. */
  pool: Lead[];
  value: LeadFilterState;
  onChange: (next: LeadFilterState) => void;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const options = buildOptions(pool, value);
  const n = activeCount(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const set = (patch: Partial<LeadFilterState>) => onChange({ ...value, ...patch });

  // Every answer, as a chip you can take back off without opening anything.
  const chips: { label: string; clear: () => void }[] = [];
  if (value.cities.length)
    chips.push({ label: `${value.cities.length} town${value.cities.length === 1 ? "" : "s"}`, clear: () => set({ cities: [], zips: [] }) });
  if (value.zips.length)
    chips.push({ label: `${value.zips.length} ZIP${value.zips.length === 1 ? "" : "s"}`, clear: () => set({ zips: [] }) });
  if (value.lists.length)
    chips.push({ label: `${value.lists.length} list${value.lists.length === 1 ? "" : "s"}`, clear: () => set({ lists: [] }) });
  if (value.months.length)
    chips.push({ label: `${value.months.length} month${value.months.length === 1 ? "" : "s"}`, clear: () => set({ months: [] }) });
  if (value.counties.length)
    chips.push({ label: `${value.counties.length} count${value.counties.length === 1 ? "y" : "ies"}`, clear: () => set({ counties: [] }) });
  if (value.band !== "any")
    chips.push({
      label: VALUE_BANDS.find((b) => b.key === value.band)?.label || value.band,
      clear: () => set({ band: "any" }),
    });
  if (value.occupancy !== "any")
    chips.push({
      label: OCCUPANCY_OPTIONS.find((o) => o.key === value.occupancy)?.label || value.occupancy,
      clear: () => set({ occupancy: "any" }),
    });
  if (value.maxMiles > 0)
    chips.push({
      label: `${value.maxMiles} mi of ${value.origin === "me" ? "me" : "the office"}`,
      clear: () => set({ maxMiles: 0 }),
    });

  const monthOptions = [
    ...MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: `${m} birthdays` })),
    { value: String(MONTH_UNKNOWN), label: "No birth month on file" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div ref={wrap} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={
            n > 0
              ? "flex items-center gap-1.5 rounded-lg border border-brand bg-brand-light px-3 py-1.5 text-xs font-semibold text-brand-dark"
              : "flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-worked hover:bg-paper"
          }
        >
          <SlidersHorizontal size={13} aria-hidden />
          Filters{n > 0 ? ` (${n})` : ""}
        </button>

        {open && (
          <div className="absolute left-0 z-40 mt-1 w-[min(92vw,22rem)] rounded-xl border border-line bg-white p-3 shadow-lift">
            <div className="grid grid-cols-2 gap-2">
              <MultiSelect
                size={size} label="town" allLabel="All towns" options={options.cities}
                selected={value.cities}
                onChange={(next) => set({ cities: next, zips: pruneZips(pool, next, value.zips) })}
              />
              <MultiSelect
                size={size} label="ZIP" allLabel="All ZIPs" options={options.zips}
                selected={value.zips} onChange={(zips) => set({ zips })}
              />
              <MultiSelect
                size={size} label="list" allLabel="All lists" options={options.lists}
                selected={value.lists} onChange={(lists) => set({ lists })}
              />
              <MultiSelect
                size={size} label="month" allLabel="Any birth month" options={monthOptions}
                selected={value.months} onChange={(months) => set({ months })} searchable={false}
              />
              <MultiSelect
                size={size} label="county" allLabel="All counties" options={options.counties}
                selected={value.counties} onChange={(counties) => set({ counties })}
              />
              <select
                aria-label="Filter by who lives there"
                value={value.occupancy}
                onChange={(e) => set({ occupancy: e.target.value as Occupancy })}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked"
              >
                {OCCUPANCY_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </div>

            <select
              aria-label="Filter by home value"
              value={value.band}
              onChange={(e) => set({ band: e.target.value })}
              className={
                value.band === "any"
                  ? "mt-2 w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked"
                  : "mt-2 w-full rounded-lg border border-brand bg-brand-light px-2.5 py-1.5 text-xs font-semibold text-brand-dark"
              }
            >
              {BAND_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {VALUE_BANDS.filter((b) => b.group === g).map((b) => (
                    <option key={b.key} value={b.key}>{b.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>

            {value.band !== "any" && value.band !== "unknown" && (
              <label className="mt-2 flex items-center gap-1.5 text-xs text-worked">
                <input
                  type="checkbox"
                  checked={value.includeUnpriced}
                  onChange={(e) => set({ includeUnpriced: e.target.checked })}
                />
                Keep doors we&apos;ve never priced
              </label>
            )}

            {/* How far out is worth a call. The book now reaches Chapel Hill
                and Salisbury, and an appointment out there is most of a day in
                the car for one application. */}
            <div className="mt-2 flex gap-2">
              <select
                aria-label="Filter by distance"
                value={String(value.maxMiles)}
                onChange={(e) => set({ maxMiles: Number(e.target.value) })}
                className={
                  value.maxMiles === 0
                    ? "flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked"
                    : "flex-1 rounded-lg border border-brand bg-brand-light px-2.5 py-1.5 text-xs font-semibold text-brand-dark"
                }
              >
                {DISTANCE_BANDS.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
              {value.maxMiles > 0 && (
                <select
                  aria-label="Measure distance from"
                  value={value.origin}
                  onChange={(e) => set({ origin: e.target.value as DistanceOrigin })}
                  className="flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked"
                >
                  <option value="office">of the office</option>
                  <option value="me">of where I am</option>
                </select>
              )}
            </div>

            {value.maxMiles > 0 && (
              <label className="mt-2 flex items-center gap-1.5 text-xs text-worked">
                <input
                  type="checkbox"
                  checked={value.includeUnmapped}
                  onChange={(e) => set({ includeUnmapped: e.target.checked })}
                />
                Keep leads we could never put on the map
              </label>
            )}

            <div className="mt-3 flex justify-between">
              <button
                onClick={() => onChange({ ...emptyFilter })}
                disabled={n === 0}
                className="rounded-md px-2 py-1 text-xs text-worked hover:bg-paper disabled:opacity-40"
              >
                Clear all
              </button>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-dark"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {chips.map((c) => (
        <button
          key={c.label}
          onClick={c.clear}
          className="flex items-center gap-1 rounded-lg border border-brand/40 bg-brand-light/60 px-2 py-1 text-[11px] font-medium text-brand-dark hover:bg-brand-light"
        >
          {c.label}
          <X size={10} aria-hidden />
        </button>
      ))}
    </div>
  );
}
