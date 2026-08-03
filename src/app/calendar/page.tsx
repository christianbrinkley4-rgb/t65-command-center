"use client";

// What does the day actually hold.
//
// Today answers "what's due"; this answers "what's my week". Appointments,
// planned actions, callbacks and sequence touches on one timeline, day by day,
// so you can see Tuesday is empty and Thursday has four appointments before
// you commit to anything.
//
// Everything here already exists in the book — appointment_datetime,
// lead_actions.due_at, next_follow_up_date, the sequence's next touch. The
// work is putting them on the same axis.

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, Clock, Phone, MapPin, ChevronLeft, ChevronRight } from "lucide-react";
import { useApp } from "@/lib/context";
import { effectiveDueDate, matchesWho } from "@/lib/buckets";
import { localYmd, todayStr } from "@/lib/sequences";
import { downloadIcs } from "@/lib/calendar";
import { buildQueue } from "@/lib/priority";
import LeadPanel from "@/components/LeadPanel";
import T65Badge from "@/components/T65Badge";
import type { LeadWithBucket } from "@/lib/types";

const DAYS_SHOWN = 14;

type Entry = {
  lead: LeadWithBucket;
  kind: "Appointment" | "Call" | "Follow-up" | "Touch" | "Door Knock" | "Text" | "Email" | "Mail" | "Other";
  /** Local YYYY-MM-DD the entry belongs to. */
  day: string;
  /** Sortable within the day; timed entries first. */
  at: number | null;
  label: string;
  who: string | null;
  note: string | null;
};

function dayLabel(ymd: string): string {
  const d = new Date(ymd + "T00:00:00");
  const today = todayStr();
  if (ymd === today) return "Today";
  const t = new Date(today + "T00:00:00");
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default function CalendarPage() {
  const { leads, leadsLoading, who, me } = useApp();
  const [offset, setOffset] = useState(0); // weeks from today
  const [selected, setSelected] = useState<string>(todayStr());
  const [drawerLead, setDrawerLead] = useState<LeadWithBucket | null>(null);

  // Every dated commitment in the book, flattened.
  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const l of leads) {
      if (!matchesWho(l, who)) continue;

      if (l.appointment_datetime) {
        const d = new Date(l.appointment_datetime);
        if (!isNaN(d.getTime())) {
          out.push({
            lead: l, kind: "Appointment", day: localYmd(d), at: d.getTime(),
            label: `Appointment ${timeOf(l.appointment_datetime)}`,
            who: l.assigned_to && l.assigned_to !== "Both" ? l.assigned_to : null,
            note: l.city || null,
          });
        }
      }

      for (const a of l._actions || []) {
        if (a.status !== "pending") continue;
        const d = new Date(a.due_at);
        if (isNaN(d.getTime())) continue;
        out.push({
          lead: l, kind: (a.action_type as Entry["kind"]) || "Other", day: localYmd(d), at: d.getTime(),
          label: `${a.action_type} ${timeOf(a.due_at)}`,
          who: a.assigned_to && a.assigned_to !== "Either" ? a.assigned_to : null,
          note: a.note || null,
        });
      }

      // A callback with no action behind it. Date only, so it sorts last.
      const fu = l.next_follow_up_date ? String(l.next_follow_up_date).slice(0, 10) : null;
      const hasAction = (l._actions || []).some((a) => a.status === "pending");
      if (fu && !hasAction && !l.appointment_datetime) {
        out.push({
          lead: l, kind: "Follow-up", day: fu, at: null,
          label: "Follow up", who: null, note: l.next_follow_up_note || null,
        });
      }

      if (l._enr && l._enr.status === "active" && l._enr.next_touch_date) {
        out.push({
          lead: l, kind: "Touch", day: String(l._enr.next_touch_date).slice(0, 10), at: null,
          label: `Nurture step ${l._enr.current_step}`, who: null, note: null,
        });
      }
    }
    return out;
  }, [leads, who]);

  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) m.set(e.day, [...(m.get(e.day) || []), e]);
    for (const list of m.values()) {
      list.sort((a, b) => {
        if (a.at && b.at) return a.at - b.at;
        if (a.at) return -1;
        if (b.at) return 1;
        return String(a.lead.name).localeCompare(String(b.lead.name));
      });
    }
    return m;
  }, [entries]);

  // The strip of days on offer, a fortnight at a time.
  const days = useMemo(() => {
    const start = new Date(todayStr() + "T00:00:00");
    start.setDate(start.getDate() + offset * DAYS_SHOWN);
    return Array.from({ length: DAYS_SHOWN }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return localYmd(d);
    });
  }, [offset]);

  // Anything overdue is shown up front regardless of which day you're on: a
  // callback from last Tuesday doesn't stop mattering because the week turned.
  const overdue = useMemo(
    () => entries.filter((e) => e.day < todayStr()).sort((a, b) => b.day.localeCompare(a.day)),
    [entries]
  );

  const shown = byDay.get(selected) || [];
  const appointments = shown.filter((e) => e.kind === "Appointment");
  const callbacks = shown.filter((e) => e.kind !== "Appointment");

  // Third block: everyone else the queue would hand you on this day. Only
  // meaningful for today — tomorrow's queue isn't knowable until tomorrow's
  // overdue has rolled in.
  const dueToday = useMemo(() => {
    if (selected !== todayStr()) return [];
    const booked = new Set(shown.map((e) => e.lead.id));
    return buildQueue(leads.filter((l) => matchesWho(l, who))).filter((l) => !booked.has(l.id));
  }, [leads, who, selected, shown]);

  // "2,394 due" is not a plan, it's the whole book — the queue deliberately
  // flows into never-dialed leads so it never comes back empty, and counting
  // that as today's obligation makes the number meaningless and the day look
  // lost before it starts. Only leads with a date that has actually arrived
  // are owed today. Everything behind them is fresh inventory to dial into
  // once the owed work is done.
  const owedToday = useMemo(() => {
    const today = todayStr();
    return dueToday.filter((l) => {
      const due = effectiveDueDate(l, l._enr);
      return !!due && due <= today;
    });
  }, [dueToday]);
  const freshBehind = dueToday.length - owedToday.length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Calendar</h1>
          <p className="text-sm text-worked tabular-nums">
            {leadsLoading
              ? "Loading…"
              : `${entries.length.toLocaleString()} dated commitments · ${overdue.length} overdue`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setOffset((o) => o - 1)}
            aria-label="Previous two weeks"
            className="rounded-lg border border-line bg-white px-2 py-1.5 text-worked hover:bg-paper"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => { setOffset(0); setSelected(todayStr()); }}
            className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-worked hover:bg-paper"
          >
            Today
          </button>
          <button
            onClick={() => setOffset((o) => o + 1)}
            aria-label="Next two weeks"
            className="rounded-lg border border-line bg-white px-2 py-1.5 text-worked hover:bg-paper"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* The fortnight. Counts on each chip so an empty Thursday is obvious. */}
      <div className="mb-4 grid grid-cols-7 gap-1.5">
        {days.map((d) => {
          const list = byDay.get(d) || [];
          const appts = list.filter((e) => e.kind === "Appointment").length;
          const isToday = d === todayStr();
          const on = d === selected;
          return (
            <button
              key={d}
              onClick={() => setSelected(d)}
              className={
                on
                  ? "rounded-xl bg-brand px-1 py-2 text-center text-white"
                  : `rounded-xl border px-1 py-2 text-center hover:bg-paper ${isToday ? "border-brand bg-brand-light" : "border-line bg-white"}`
              }
            >
              <span className="block text-[10px] uppercase opacity-70">
                {new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span className="block text-sm font-semibold tabular-nums">
                {new Date(d + "T00:00:00").getDate()}
              </span>
              <span className={`block text-[10px] tabular-nums ${on ? "text-white/80" : "text-later"}`}>
                {list.length === 0 ? "—" : appts > 0 ? `${appts} appt${appts === 1 ? "" : "s"}` : list.length}
              </span>
            </button>
          );
        })}
      </div>

      {overdue.length > 0 && selected === todayStr() && (
        <div className="mb-4 rounded-2xl border border-overdue/40 bg-overdue-50 p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-overdue">
            {overdue.length} overdue
          </p>
          <div className="space-y-1">
            {overdue.slice(0, 6).map((e, i) => (
              <button
                key={`${e.lead.id}-${i}`}
                onClick={() => setDrawerLead(e.lead)}
                className="block w-full truncate text-left text-xs text-overdue hover:underline"
              >
                {dayLabel(e.day)} · {e.kind} · {e.lead.name || "Unnamed"}
                {e.note ? ` — ${e.note}` : ""}
              </button>
            ))}
            {overdue.length > 6 && (
              <p className="text-[11px] text-overdue/80">…and {overdue.length - 6} more</p>
            )}
          </div>
        </div>
      )}

      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">{dayLabel(selected)}</h2>
        <p className="text-xs text-worked tabular-nums">
          {appointments.length} appointment{appointments.length === 1 ? "" : "s"} ·{" "}
          {callbacks.length} callback{callbacks.length === 1 ? "" : "s"}
          {owedToday.length ? ` · ${owedToday.length} owed a call` : ""}
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
        {shown.length > 0 && (
          <p className="border-b border-line bg-paper/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-later">
            Booked first, then callbacks
          </p>
        )}
        {shown.length === 0 && (
          <div className="p-10 text-center">
            <CalendarDays className="mx-auto mb-2 text-later" size={22} aria-hidden />
            <p className="text-sm text-later">
              Nothing booked. Good day to work the{" "}
              <Link href="/list/" className="text-brand underline-offset-2 hover:underline">
                Power List
              </Link>{" "}
              or plan a{" "}
              <Link href="/knock/" className="text-brand underline-offset-2 hover:underline">
                door route
              </Link>
              .
            </p>
          </div>
        )}

        {shown.map((e, i) => (
          <div
            key={`${e.lead.id}-${i}`}
            className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-paper/40"
          >
            <span
              className={
                e.kind === "Appointment"
                  ? "mt-0.5 w-24 shrink-0 rounded-md bg-newlead/10 px-1.5 py-0.5 text-center text-[11px] font-semibold text-newlead"
                  : "mt-0.5 w-24 shrink-0 rounded-md bg-paper px-1.5 py-0.5 text-center text-[11px] font-medium text-worked"
              }
            >
              {e.at ? timeOf(new Date(e.at).toISOString()) : e.kind}
            </span>
            <button onClick={() => setDrawerLead(e.lead)} className="min-w-0 flex-1 text-left">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                <span className="truncate">{e.lead.name || "Unnamed"}</span>
                <T65Badge birthday={e.lead.birthday} />
              </p>
              <p className="truncate text-xs text-later">
                {e.label}
                {e.who ? ` · ${e.who}` : ""}
                {e.note ? ` — ${e.note}` : ""}
              </p>
            </button>
            <div className="flex shrink-0 items-center gap-1">
              {e.lead.phone && (
                <a
                  href={`tel:${e.lead.phone}`}
                  aria-label={`Call ${e.lead.name || "lead"}`}
                  className="rounded-md border border-line p-1.5 text-worked hover:bg-paper"
                >
                  <Phone size={13} />
                </a>
              )}
              {e.kind === "Appointment" && (
                <>
                  {e.lead.address && (
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(String(e.lead.address))}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Directions"
                      className="rounded-md border border-line p-1.5 text-worked hover:bg-paper"
                    >
                      <MapPin size={13} />
                    </a>
                  )}
                  <button
                    onClick={() => downloadIcs(e.lead)}
                    title="Add to Outlook"
                    className="rounded-md border border-line p-1.5 text-worked hover:bg-paper"
                  >
                    <Clock size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Once the booked work is done, this is the rest of the day. */}
      {dueToday.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-white shadow-card">
          <div className="flex items-baseline justify-between border-b border-line bg-paper/60 px-3 py-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-later">
              {owedToday.length
                ? `Then dial · ${owedToday.length} owed a call today`
                : "Then dial · nothing owed, working fresh leads"}
            </p>
            <Link href="/session/" className="text-[11px] font-semibold text-brand hover:underline">
              Start a dial session
            </Link>
          </div>
          {dueToday.slice(0, 12).map((l) => (
            <button
              key={l.id}
              onClick={() => setDrawerLead(l)}
              className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-paper/40"
            >
              <span className="w-28 shrink-0 truncate text-[11px] text-later">
                {(l._why || [])[0] || "next in line"}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{l.name || "Unnamed"}</span>
              <span className="shrink-0 text-xs text-later">{l.city || ""}</span>
            </button>
          ))}
          {dueToday.length > 12 && (
            <p className="px-3 py-2 text-[11px] text-later">
              {owedToday.length > 12
                ? `…and ${(owedToday.length - 12).toLocaleString()} more owed a call`
                : ""}
              {owedToday.length > 12 && freshBehind > 0 ? ", then " : ""}
              {freshBehind > 0
                ? `${freshBehind.toLocaleString()} fresh leads behind them`
                : ""}
              .
            </p>
          )}
        </div>
      )}

      <LeadPanel lead={drawerLead} onClose={() => setDrawerLead(null)} />
    </div>
  );
}
