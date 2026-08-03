"use client";

// The scoreboard: who did what, when, and when it actually worked.
//
// Stats could tell you how many calls were made today and in the last 7 days,
// per person, and nothing else. Which is enough to know whether you showed up
// and useless for deciding anything. The three questions worth answering are:
//
//   How am I doing against Will, on the numbers that matter?
//   What hours should I be on the phone?
//   Am I keeping it up, or was last Tuesday a one-off?
//
// One 90-day fetch, filtered in memory, so switching Today / 7 / 30 / 90 is
// instant and costs nothing.

import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { isConversation, isDial, isReached } from "@/lib/callOutcomes";
import type { Activity } from "@/lib/types";

const PEOPLE = ["Christian", "Will"] as const;
const PERIODS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

/** Below this a percentage is noise, and printing it invites a bad decision. */
const MIN_SAMPLE = 8;

const DIAL_START = 8;
const DIAL_END = 20; // 8pm; the 8-9pm hour is legal but barely used

type Tally = {
  dials: number;
  reached: number;
  conversations: number;
  appts: number;
  sold: number;
  doors: number;
};

const emptyTally = (): Tally => ({ dials: 0, reached: 0, conversations: 0, appts: 0, sold: 0, doors: 0 });

function add(t: Tally, a: Activity) {
  if (isDial(a.activity_type, a.outcome)) {
    t.dials += 1;
    if (isReached(a.outcome)) t.reached += 1;
    if (isConversation(a.outcome)) t.conversations += 1;
  }
  if (a.activity_type === "Door Knock" && a.outcome && a.outcome !== "Note") t.doors += 1;
  if (a.activity_type === "Appointment" && /set/i.test(a.outcome || "")) t.appts += 1;
  if (a.activity_type === "Sale") t.sold += 1;
}

const pct = (n: number, d: number) => (d >= MIN_SAMPLE ? `${Math.round((n / d) * 100)}%` : "—");

function localHour(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getHours();
}
function localDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const hourLabel = (h: number) =>
  h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`;

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-card">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-later">{hint}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function ActivityStats() {
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("30");

  useEffect(() => {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    supabase
      .from("activity_log")
      .select("id, lead_id, activity_type, activity_date, outcome, notes, logged_by")
      .gte("activity_date", since.toISOString())
      .order("activity_date", { ascending: false })
      .limit(20000)
      .then(({ data }) => setRows((data || []) as Activity[]));
  }, []);

  // The backfilled tracker and SmartAsset rows are history, not work anybody
  // did in this app on that date — counting them would put a spike on whatever
  // day the import ran.
  const work = useMemo(
    () => (rows || []).filter((a) => a.activity_type !== "History"),
    [rows]
  );

  const inPeriod = useMemo(() => {
    const cutoff = new Date();
    if (period === "today") cutoff.setHours(0, 0, 0, 0);
    else cutoff.setDate(cutoff.getDate() - Number(period));
    return work.filter((a) => a.activity_date && new Date(a.activity_date) >= cutoff);
  }, [work, period]);

  const scoreboard = useMemo(() => {
    const byPerson = new Map<string, Tally>();
    const team = emptyTally();
    for (const p of PEOPLE) byPerson.set(p, emptyTally());
    for (const a of inPeriod) {
      add(team, a);
      const who = a.logged_by || "";
      const t = byPerson.get(who);
      if (t) add(t, a);
    }
    return { byPerson, team };
  }, [inPeriod]);

  const byHour = useMemo(() => {
    const out = Array.from({ length: DIAL_END - DIAL_START + 1 }, (_, i) => ({
      hour: DIAL_START + i,
      dials: 0,
      reached: 0,
    }));
    for (const a of inPeriod) {
      if (!isDial(a.activity_type, a.outcome)) continue;
      const h = localHour(a.activity_date);
      if (h === null || h < DIAL_START || h > DIAL_END) continue;
      const slot = out[h - DIAL_START];
      slot.dials += 1;
      if (isReached(a.outcome)) slot.reached += 1;
    }
    return out;
  }, [inPeriod]);

  const bestHour = useMemo(() => {
    const eligible = byHour.filter((h) => h.dials >= MIN_SAMPLE);
    if (!eligible.length) return null;
    return eligible.reduce((a, b) => (b.reached / b.dials > a.reached / a.dials ? b : a));
  }, [byHour]);

  const byWeekday = useMemo(() => {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const out = names.map((name) => ({ name, dials: 0, reached: 0 }));
    for (const a of inPeriod) {
      if (!isDial(a.activity_type, a.outcome) || !a.activity_date) continue;
      const d = new Date(a.activity_date);
      if (isNaN(d.getTime())) continue;
      out[d.getDay()].dials += 1;
      if (isReached(a.outcome)) out[d.getDay()].reached += 1;
    }
    return out.slice(1, 6); // Mon-Fri; weekends are noise here
  }, [inPeriod]);

  // Last 14 days, always, regardless of the period toggle — this panel answers
  // "am I keeping it up", which needs a fixed window to read as a trend.
  const last14 = useMemo(() => {
    const days: { day: string; label: string; byPerson: Record<string, number>; total: number }[] = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - 13);
    for (let i = 0; i < 14; i++) {
      const p = (n: number) => String(n).padStart(2, "0");
      const key = `${cursor.getFullYear()}-${p(cursor.getMonth() + 1)}-${p(cursor.getDate())}`;
      days.push({
        day: key,
        label: cursor.toLocaleDateString(undefined, { weekday: "narrow" }),
        byPerson: { Christian: 0, Will: 0 },
        total: 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    const index = new Map(days.map((d) => [d.day, d]));
    for (const a of work) {
      if (!isDial(a.activity_type, a.outcome)) continue;
      const key = localDay(a.activity_date);
      const slot = key ? index.get(key) : null;
      if (!slot) continue;
      slot.total += 1;
      const who = a.logged_by || "";
      if (who in slot.byPerson) slot.byPerson[who] += 1;
    }
    return days;
  }, [work]);

  if (rows === null) {
    return (
      <div className="mt-4 rounded-xl border border-line bg-white p-6 text-sm text-later shadow-card">
        Loading activity…
      </div>
    );
  }

  const maxDay = Math.max(1, ...last14.map((d) => d.total));
  const maxHour = Math.max(1, ...byHour.map((h) => h.dials));
  const periodLabel = PERIODS.find((p) => p.key === period)?.label.toLowerCase() || "";

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">Activity</h2>
        <div className="flex items-center gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={
                period === p.key
                  ? "rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white"
                  : "rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-worked hover:bg-paper"
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Who did what */}
      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-card">
        <p className="border-b border-line bg-paper/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-later">
          Scoreboard · {periodLabel}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[38rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-later">
                <th className="px-4 py-2 font-medium">Who</th>
                <th className="px-4 py-2 text-right font-medium">Dials</th>
                <th className="px-4 py-2 text-right font-medium">Picked up</th>
                <th className="px-4 py-2 text-right font-medium">Pickup&nbsp;%</th>
                <th className="px-4 py-2 text-right font-medium">Conversations</th>
                <th className="px-4 py-2 text-right font-medium">Appts</th>
                <th className="px-4 py-2 text-right font-medium">Sold</th>
                <th className="px-4 py-2 text-right font-medium">Doors</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {PEOPLE.map((p) => {
                const t = scoreboard.byPerson.get(p)!;
                return (
                  <tr key={p} className="border-b border-line">
                    <td className="px-4 py-2 font-medium text-ink">{p}</td>
                    <td className="px-4 py-2 text-right text-worked">{t.dials.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-worked">{t.reached.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-worked">{pct(t.reached, t.dials)}</td>
                    <td className="px-4 py-2 text-right text-worked">{t.conversations.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-worked">{t.appts.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-worked">{t.sold.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-worked">{t.doors.toLocaleString()}</td>
                  </tr>
                );
              })}
              <tr className="bg-paper/50 font-semibold">
                <td className="px-4 py-2 text-ink">Team</td>
                <td className="px-4 py-2 text-right text-ink">{scoreboard.team.dials.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-ink">{scoreboard.team.reached.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-ink">{pct(scoreboard.team.reached, scoreboard.team.dials)}</td>
                <td className="px-4 py-2 text-right text-ink">{scoreboard.team.conversations.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-ink">{scoreboard.team.appts.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-ink">{scoreboard.team.sold.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-ink">{scoreboard.team.doors.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {/* The one number you can plan a week with. "Book four appointments"
            is a wish; "book four appointments, so put 280 dials in the diary"
            is a schedule. */}
        {scoreboard.team.appts > 0 && (
          <p className="border-t border-line bg-brand-light/40 px-4 py-2.5 text-sm text-brand-dark">
            <strong className="tabular-nums">
              {Math.round(scoreboard.team.dials / scoreboard.team.appts)} dials per appointment
            </strong>{" "}
            over the last {periodLabel}. Another appointment costs about that many calls, so a week
            with four in it is roughly{" "}
            <span className="tabular-nums font-semibold">
              {(Math.round(scoreboard.team.dials / scoreboard.team.appts) * 4).toLocaleString()}
            </span>{" "}
            dials between the two of you.
          </p>
        )}
        <p className="border-t border-line px-4 py-2 text-[11px] text-later">
          &ldquo;Picked up&rdquo; is any human answering, including a wrong person.
          &ldquo;Conversations&rdquo; is the prospect themselves. A percentage shows only once
          there are {MIN_SAMPLE} dials behind it — anything less is a coin toss with a number on it.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* When to be on the phone */}
        <Panel
          title="Best hours to dial"
          hint={
            bestHour
              ? `Over the last ${periodLabel}, ${hourLabel(bestHour.hour)}–${hourLabel(bestHour.hour + 1)} is your best hour: ${Math.round((bestHour.reached / bestHour.dials) * 100)}% pick up.`
              : "Once an hour has 8 dials behind it, the pickup rate shows here and you can stop guessing when to call."
          }
        >
          <div className="space-y-1.5">
            {byHour.map((h) => {
              const rate = h.dials >= MIN_SAMPLE ? h.reached / h.dials : null;
              return (
                <div key={h.hour} className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-later">
                    {hourLabel(h.hour)}
                  </span>
                  <div className="relative h-4 flex-1 overflow-hidden rounded bg-paper">
                    <div
                      className="absolute inset-y-0 left-0 bg-line"
                      style={{ width: `${(h.dials / maxHour) * 100}%` }}
                      title={`${h.dials} dials`}
                    />
                    <div
                      className={
                        bestHour && h.hour === bestHour.hour
                          ? "absolute inset-y-0 left-0 bg-brand"
                          : "absolute inset-y-0 left-0 bg-newlead"
                      }
                      style={{ width: `${(h.reached / maxHour) * 100}%` }}
                      title={`${h.reached} picked up`}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-worked">
                    {h.dials === 0 ? "" : rate === null ? `${h.dials} dials` : `${Math.round(rate * 100)}%`}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 flex items-center gap-3 text-[11px] text-later">
            <span className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm bg-line" /> dialled
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm bg-newlead" /> picked up
            </span>
          </p>
        </Panel>

        {/* Day of week */}
        <Panel
          title="Which days connect"
          hint="Same measure by weekday. Worth knowing before you plan a week around a hunch."
        >
          <div className="space-y-2">
            {byWeekday.map((d) => {
              const max = Math.max(1, ...byWeekday.map((x) => x.dials));
              return (
                <div key={d.name} className="flex items-center gap-2">
                  <span className="w-9 shrink-0 text-[11px] text-later">{d.name}</span>
                  <div className="relative h-4 flex-1 overflow-hidden rounded bg-paper">
                    <div className="absolute inset-y-0 left-0 bg-line" style={{ width: `${(d.dials / max) * 100}%` }} />
                    <div className="absolute inset-y-0 left-0 bg-newlead" style={{ width: `${(d.reached / max) * 100}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-worked">
                    {d.dials === 0 ? "—" : `${d.dials} · ${pct(d.reached, d.dials)}`}
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* Consistency */}
      <Panel
        title="Last 14 days"
        hint="Dials per day, split by who made them. This one ignores the period buttons on purpose — a trend needs a fixed window."
      >
        <div className="flex items-end gap-1.5">
          {last14.map((d) => (
            <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-[10px] tabular-nums text-later">{d.total || ""}</span>
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t"
                style={{ height: `${Math.max(3, (d.total / maxDay) * 90)}px` }}
                title={`${d.day}: ${d.byPerson.Christian} Christian · ${d.byPerson.Will} Will`}
              >
                <div
                  className="w-full bg-brand"
                  style={{ height: `${d.total ? (d.byPerson.Christian / d.total) * 100 : 0}%` }}
                />
                <div
                  className="w-full bg-month"
                  style={{ height: `${d.total ? (d.byPerson.Will / d.total) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-later">{d.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 flex items-center gap-3 text-[11px] text-later">
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-brand" /> Christian
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-month" /> Will
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Clock size={11} aria-hidden /> {work.length.toLocaleString()} logged touches in 90 days
          </span>
        </p>
      </Panel>
    </div>
  );
}
