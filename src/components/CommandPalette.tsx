"use client";

// One key to reach anything. Ctrl-K, or ⌘K on a Mac.
//
// The app had 2,729 people in it and exactly one way to reach a specific one:
// leave whatever you were doing, go to the Search tab, type, click. Mid-call
// that's four moves and a lost place in the queue — so in practice nobody
// looked anyone up, which is how you end up dialing someone Will spoke to
// yesterday.
//
// It searches the book that is already in memory, so it works with no signal
// and answers on the keystroke. It also carries the navigation, because a
// palette that finds people but can't open the Day view is a search box with
// extra steps.
//
// Ranking is the whole trick. Typing "336" should not return three hundred
// Greensboro numbers in import order — an exact phone match beats a name that
// starts with the query, which beats a name that contains it, which beats a
// city. Ties break on the priority score, so of two Bill Hartleys you get the
// one who is actually due.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, Command, UserRoundPlus } from "lucide-react";
import { useApp } from "@/lib/context";
import { ALL_NAV } from "@/lib/nav";
import { canonicalPhone } from "@/lib/phone";
import { scoreLead } from "@/lib/priority";
import { effectiveDueDate } from "@/lib/buckets";
import T65Badge from "@/components/T65Badge";
import LeadPanel from "@/components/LeadPanel";
import NewLeadDialog from "@/components/NewLeadDialog";
import type { LeadWithBucket } from "@/lib/types";

type Row =
  | { kind: "lead"; id: string; lead: LeadWithBucket; rank: number }
  | { kind: "nav"; id: string; label: string; hint: string; href: string }
  | { kind: "action"; id: string; label: string; hint: string; run: () => void };

const MAX_LEADS = 8;

/** Anything can ask for the palette: window.dispatchEvent(new Event(OPEN_PALETTE)). */
export const OPEN_PALETTE = "t65:open-palette";

function dueSummary(lead: LeadWithBucket): string {
  if (lead.appointment_datetime) {
    const d = new Date(lead.appointment_datetime);
    if (!isNaN(d.getTime())) {
      return `appointment ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    }
  }
  const due = effectiveDueDate(lead, lead._enr);
  if (!due) return lead._bucket === "New" ? "never dialed" : "no date set";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(due + "T00:00:00").getTime() - today.getTime()) / 86400000);
  if (diff < 0) return `${-diff}d overdue`;
  if (diff === 0) return "due today";
  return `due in ${diff}d`;
}

export default function CommandPalette() {
  const router = useRouter();
  const { leads } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [panelLead, setPanelLead] = useState<LeadWithBucket | null>(null);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
        setCursor(0);
      }
    }
    // The header's search button fires this, so the palette stays the only
    // thing that knows how to open itself.
    const onOpenRequest = () => {
      setOpen(true);
      setQ("");
      setCursor(0);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE, onOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const query = q.trim().toLowerCase();
    const digits = canonicalPhone(q);

    const navRows: Row[] = ALL_NAV.filter(
      (n) => !query || n.label.toLowerCase().includes(query) || n.hint.toLowerCase().includes(query)
    ).map((n) => ({ kind: "nav", id: `nav-${n.href}`, label: n.label, hint: n.hint, href: n.href }));

    const actionRows: Row[] = [
      {
        kind: "action" as const,
        id: "action-add",
        label: "Add a lead",
        hint: "Type in one person — a referral, someone you met",
        run: () => setAdding(true),
      },
    ].filter((a) => !query || a.label.toLowerCase().includes(query) || query.startsWith("add"));

    if (!query) {
      // Nothing typed: offer the map, not a thousand strangers.
      return [...navRows, ...actionRows];
    }

    const leadRows: Row[] = [];
    for (const l of leads) {
      const name = (l.name || "").toLowerCase();
      const phone = canonicalPhone(l.phone);
      const phone2 = canonicalPhone(l.phone2);
      const city = (l.city || "").toLowerCase();
      const address = (l.address || "").toLowerCase();
      const email = (l.email || "").toLowerCase();

      let rank = 0;
      if (digits.length >= 4 && (phone.includes(digits) || phone2.includes(digits))) {
        rank = phone === digits || phone2 === digits ? 100 : 70;
      } else if (name.startsWith(query)) rank = 90;
      // A surname typed on its own is the common case at a door.
      else if (name.split(/\s+/).some((part) => part.startsWith(query))) rank = 80;
      else if (name.includes(query)) rank = 60;
      else if (address.includes(query)) rank = 40;
      else if (email.includes(query)) rank = 35;
      else if (city.includes(query)) rank = 20;
      if (rank === 0) continue;
      leadRows.push({ kind: "lead", id: l.id, lead: l, rank });
    }

    leadRows.sort((a, b) => {
      if (a.kind !== "lead" || b.kind !== "lead") return 0;
      if (a.rank !== b.rank) return b.rank - a.rank;
      return scoreLead(b.lead)._score - scoreLead(a.lead)._score;
    });

    return [...leadRows.slice(0, MAX_LEADS), ...navRows, ...actionRows];
  }, [q, leads]);

  useEffect(() => {
    setCursor(0);
  }, [q]);

  function choose(row: Row | undefined) {
    if (!row) return;
    setOpen(false);
    if (row.kind === "lead") setPanelLead(row.lead);
    else if (row.kind === "nav") router.push(row.href);
    else row.run();
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-white shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
              <Search size={16} className="shrink-0 text-later" aria-hidden />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCursor((c) => Math.min(c + 1, rows.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCursor((c) => Math.max(c - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    choose(rows[cursor]);
                  }
                }}
                placeholder="Find anyone, or go anywhere…"
                aria-label="Search leads and pages"
                className="w-full bg-transparent text-base outline-none placeholder:text-later"
              />
              <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-later sm:block">
                esc
              </kbd>
            </div>

            <div className="max-h-[52vh] overflow-y-auto">
              {rows.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-later">Nobody in the book matches &ldquo;{q}&rdquo;.</p>
                  <button
                    onClick={() => {
                      setOpen(false);
                      setAdding(true);
                    }}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark"
                  >
                    <UserRoundPlus size={13} aria-hidden /> Add them
                  </button>
                </div>
              )}

              {rows.map((row, i) => {
                const active = i === cursor;
                return (
                  <button
                    key={row.id}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(row)}
                    className={
                      active
                        ? "flex w-full items-center gap-3 bg-brand-light/60 px-4 py-2.5 text-left"
                        : "flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-paper/60"
                    }
                  >
                    {row.kind === "lead" ? (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">
                              {row.lead.name || "Unnamed"}
                            </span>
                            <T65Badge birthday={row.lead.birthday} />
                            {row.lead.do_not_call && (
                              <span className="rounded bg-overdue px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                DNC
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-later">
                            {row.lead.phone || "no phone"}
                            {row.lead.city ? ` · ${row.lead.city}` : ""}
                            {` · ${dueSummary(row.lead)}`}
                          </span>
                        </span>
                        {active && <CornerDownLeft size={13} className="shrink-0 text-brand-dark" aria-hidden />}
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{row.label}</span>
                          <span className="block truncate text-xs text-later">{row.hint}</span>
                        </span>
                        {active && <CornerDownLeft size={13} className="shrink-0 text-brand-dark" aria-hidden />}
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            <p className="flex items-center gap-3 border-t border-line bg-paper/60 px-4 py-2 text-[11px] text-later">
              <span className="flex items-center gap-1">
                <Command size={10} aria-hidden />K to open
              </span>
              <span>↑↓ to move</span>
              <span>↵ to pick</span>
              <span className="ml-auto tabular-nums">
                {leads.length.toLocaleString()} leads, searched on this device
              </span>
            </p>
          </div>
        </div>
      )}

      <LeadPanel lead={panelLead} onClose={() => setPanelLead(null)} />
      {adding && (
        <NewLeadDialog
          onClose={() => setAdding(false)}
          onCreated={(existing) => {
            if (existing) setPanelLead(existing);
          }}
        />
      )}
    </>
  );
}
