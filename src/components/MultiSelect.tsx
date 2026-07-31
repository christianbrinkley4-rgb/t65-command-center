"use client";

// Pick several: four months, three ZIPs, two lists.
//
// Not a native <select multiple>. On a phone that renders as a cramped list box
// where every tap replaces your selection unless you find the modifier key, and
// there is no modifier key in a driveway. This is a button that opens a panel
// of tap-to-toggle rows, sized for a thumb.
//
// Empty selection means EVERYTHING, not nothing. A filter you haven't touched
// should never hide a lead, and it keeps "clear" and "select all" from being
// two names for the same state.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export type MultiOption = { value: string; label: string; count?: number };

export default function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  className = "",
  searchable,
  size = "md",
}: {
  /** Singular noun for the summary line: "ZIP", "month", "list". */
  label: string;
  /** What the button reads when nothing is picked: "All ZIPs". */
  allLabel: string;
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
  /** Defaults to on once the list is long enough to scroll past. */
  searchable?: boolean;
  /** "md" is the field size (thumb targets); "sm" matches the desk filter bar. */
  size?: "md" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const showSearch = searchable ?? options.length > 12;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // "May +3" beats "4 selected": you can see what you picked without opening it.
  const summary = useMemo(() => {
    if (selected.length === 0) return allLabel;
    const first = options.find((o) => o.value === selected[0]);
    const name = first?.label ?? selected[0];
    return selected.length === 1 ? name : `${name} +${selected.length - 1}`;
  }, [selected, options, allLabel]);

  function toggle(value: string) {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
    );
  }

  const active = selected.length > 0;

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${allLabel}. ${selected.length || "none"} selected.`}
        className={[
          "flex w-full items-center justify-between gap-1 text-left",
          size === "sm" ? "rounded-lg px-2.5 py-1.5 text-xs" : "rounded-xl px-3 py-2.5 text-sm",
          active
            ? "border border-brand bg-brand-light font-semibold text-brand-dark"
            : "border border-line bg-white text-ink",
        ].join(" ")}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown size={14} className="shrink-0 opacity-60" aria-hidden />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={allLabel}
          className="absolute left-0 z-30 mt-1 max-h-[19rem] w-full min-w-[13rem] overflow-hidden rounded-xl border border-line bg-white shadow-lift"
        >
          {showSearch && (
            <div className="border-b border-line p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${label}s`}
                aria-label={`Search ${label}s`}
                className="w-full rounded-lg border border-line px-2.5 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          )}

          <div className="max-h-56 overflow-y-auto py-1">
            {shown.length === 0 && (
              <p className="px-3 py-3 text-sm text-later">No {label}s match “{query}”.</p>
            )}
            {shown.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-paper"
                >
                  <span
                    className={
                      on
                        ? "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-brand bg-brand text-white"
                        : "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line"
                    }
                    aria-hidden
                  >
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink">{o.label}</span>
                  {o.count != null && (
                    <span className="shrink-0 text-xs tabular-nums text-later">{o.count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-line px-2 py-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-worked hover:bg-paper disabled:opacity-40"
            >
              <X size={11} aria-hidden /> Clear
            </button>
            <button
              type="button"
              onClick={() => onChange(shown.map((o) => o.value))}
              className="rounded-md px-2 py-1.5 text-xs text-worked hover:bg-paper"
            >
              {query.trim() ? `Select these ${shown.length}` : "Select all"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
