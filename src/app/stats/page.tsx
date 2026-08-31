"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/context";
import { matchesWho } from "@/lib/buckets";
import { normalizeSource } from "@/lib/categories";
import { supabase } from "@/lib/supabaseClient";
import StatCard from "@/components/StatCard";
import BarList from "@/components/BarList";
import Donut from "@/components/Donut";
import ActivityStats from "@/components/ActivityStats";
import { isDial, isReached } from "@/lib/callOutcomes";
import { askedNotToBeCalled, onScrubList } from "@/lib/types";
import type { Activity } from "@/lib/types";

const SOURCE_ORDER = [
  "ProspectSheet",
  "SmartAsset",
  "BusinessTracker",
  "T65Apr",
  "T65Nov",
  "T65Dec",
  "T65Jan",
  "T65Feb",
  "T65Mar",
];

function isAppointment(status: string | null, stage: string | null) {
  const s = (status || "").toLowerCase();
  const b = (stage || "").toLowerCase();
  return s.includes("appointment") || b.includes("appointment");
}

function isClosedSold(status: string | null) {
  return (status || "").toLowerCase().includes("sold");
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-card">
      <p className="mb-3 text-sm font-semibold text-ink">{title}</p>
      {children}
    </div>
  );
}

export default function StatsPage() {
  const { leads, leadsLoading, who, actions } = useApp();
  const [recentActivity, setRecentActivity] = useState<Activity[]>([]);
  const [dialGoal, setDialGoal] = useState(40);

  useEffect(() => {
    const g = Number(localStorage.getItem("t65-cc-dial-goal"));
    if (g > 0) setDialGoal(g);
  }, []);
  const saveGoal = (n: number) => {
    setDialGoal(n);
    localStorage.setItem("t65-cc-dial-goal", String(n));
  };

  useEffect(() => {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    supabase
      .from("activity_log")
      .select("*")
      .gte("activity_date", since.toISOString())
      .limit(5000)
      .then(({ data }) => setRecentActivity((data || []) as Activity[]));
  }, [leads]);

  // Door knocking gets its own 90-day window: it's a slower cadence than
  // dialing, and a 7-day view would read as noise.
  const [knockLog, setKnockLog] = useState<Activity[]>([]);
  useEffect(() => {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    supabase
      .from("activity_log")
      .select("*")
      .eq("activity_type", "Door Knock")
      .gte("activity_date", since.toISOString())
      .limit(10000)
      .then(({ data }) => setKnockLog((data || []) as Activity[]));
  }, [leads]);

  // A 30-day query against the carrier's `calls` table used to run here on
  // every Stats load, to fill the dialer panel. The dialer is retired, so it
  // fetched an empty set every time and rendered a placeholder. Both are gone.

  const scoped = useMemo(() => leads.filter((l) => matchesWho(l, who)), [leads, who]);

  // Just the goal bar's numerator now — the per-person detail moved into
  // <ActivityStats/>, which can slice it by hour, day and period.
  const callsTodayTotal = useMemo(() => {
    const todayStr = new Date().toDateString();
    return recentActivity.filter(
      (a) =>
        isDial(a.activity_type, a.outcome) &&
        new Date(a.activity_date || 0).toDateString() === todayStr
    ).length;
  }, [recentActivity]);


  const totals = useMemo(() => {
    const total = scoped.length;
    const neverDialed = scoped.filter((l) => l._bucket === "New").length;
    const dialsLogged = scoped.reduce((sum, l) => sum + (l.dials_count || 0), 0);
    const appointments = scoped.filter((l) => isAppointment(l.status, l.stage_bucket)).length;
    const closedSold = scoped.filter((l) => isClosedSold(l.status)).length;
    const overdue = scoped.filter((l) => l._bucket === "Overdue").length;
    const inNurture = scoped.filter((l) => l._enr && l._enr.status === "active").length;
    return { total, neverDialed, dialsLogged, appointments, closedSold, overdue, inNurture };
  }, [scoped]);

  const bySource = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of scoped) {
      const s = normalizeSource(l.source);
      counts[s] = (counts[s] || 0) + 1;
    }
    const known = SOURCE_ORDER.filter((s) => counts[s]).map((s) => ({ name: s, value: counts[s] }));
    const rest = Object.entries(counts)
      .filter(([k]) => !SOURCE_ORDER.includes(k))
      .map(([name, value]) => ({ name, value }));
    return [...known, ...rest];
  }, [scoped]);

  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of scoped) {
      const s = l.status || "New";
      counts[s] = (counts[s] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7).map(([name, value]) => ({ name, value }));
    const restTotal = sorted.slice(7).reduce((sum, [, v]) => sum + v, 0);
    if (restTotal > 0) top.push({ name: "Other", value: restTotal });
    return top;
  }, [scoped]);

  const byAssignedTask = useMemo(() => {
    const counts: Record<string, number> = { Christian: 0, Will: 0, Either: 0 };
    for (const a of actions) {
      const k = a.assigned_to || "Either";
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value }));
  }, [actions]);

  const knockStats = useMemo(() => {
    // "Note" rows are annotations, not knocks — counting them would inflate
    // the denominator and quietly flatter the contact rate.
    const knocks = knockLog.filter((a) => a.outcome && a.outcome !== "Note");
    const total = knocks.length;
    const talked = knocks.filter((a) => (a.outcome || "").startsWith("Talked")).length;
    const notHome = knocks.filter((a) => a.outcome === "Not home").length;
    const appts = knockLog.filter((a) => (a.outcome || "").includes("Appointment")).length;

    const byOutcome = new Map<string, number>();
    for (const a of knocks) byOutcome.set(a.outcome!, (byOutcome.get(a.outcome!) || 0) + 1);

    const byPerson = new Map<string, number>();
    for (const a of knocks) {
      const who = a.logged_by || "Unknown";
      byPerson.set(who, (byPerson.get(who) || 0) + 1);
    }

    // Days actually worked, so "doors per day" reflects effort not calendar.
    const days = new Set(knocks.map((a) => (a.activity_date || "").slice(0, 10)).filter(Boolean));
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = knocks.filter((a) => (a.activity_date || "").startsWith(today)).length;

    return {
      total,
      talked,
      notHome,
      appts,
      todayCount,
      daysWorked: days.size,
      perDay: days.size ? Math.round((total / days.size) * 10) / 10 : 0,
      contactRate: total ? Math.round((talked / total) * 100) : null,
      apptsPer100: total ? Math.round((appts / total) * 1000) / 10 : null,
      byOutcome: Array.from(byOutcome, ([name, value]) => ({ name, value })).sort(
        (a, b) => b.value - a.value
      ),
      byPerson: Array.from(byPerson, ([name, value]) => ({ name, value })).sort(
        (a, b) => b.value - a.value
      ),
    };
  }, [knockLog]);

  // Same shape for dialing so the two channels can be compared honestly.
  // startsWith("Talked") used to be the test here, which caught the eight rows
  // saying "Talked - Interested" and missed the thirty-nine saying "Answered -
  // Spoke to Prospect" — so the phone looked far worse than the door for
  // reasons that were entirely about spelling. See lib/callOutcomes.
  const dialCompare = useMemo(() => {
    const dials = recentActivity.filter((a) => isDial(a.activity_type, a.outcome));
    const total = dials.length;
    const reached = dials.filter((a) => isReached(a.outcome)).length;
    return { total, contactRate: total ? Math.round((reached / total) * 100) : null };
  }, [recentActivity]);

  const funnel = useMemo(() => {
    const newCount = scoped.filter((l) => l._bucket === "New").length;
    const worked = scoped.filter(
      (l) => l._bucket !== "New" && ((l.dials_count || 0) > 0 || l.last_contact_date)
    ).length;
    const appt = scoped.filter((l) => isAppointment(l.status, l.stage_bucket)).length;
    const sold = scoped.filter((l) => isClosedSold(l.status)).length;
    return [
      { name: "New", value: newCount },
      { name: "Worked", value: worked },
      { name: "Appointment", value: appt },
      { name: "Sold", value: sold },
    ];
  }, [scoped]);

  const apptStats = useMemo(() => {
    const set = scoped.filter(
      (l) => l.appointment_datetime || isAppointment(l.status, l.stage_bucket)
    ).length;
    const held = scoped.filter((l) => (l.status || "") === "Appointment Held").length;
    const noShow = scoped.filter((l) => (l.status || "") === "Appointment No-Show").length;
    const sold = scoped.filter((l) => isClosedSold(l.status)).length;
    const shown = held + noShow;
    return { set, held, noShow, sold, showRate: shown ? Math.round((held / shown) * 100) : null };
  }, [scoped]);

  const sourceROI = useMemo(() => {
    const map = new Map<string, { leads: number; worked: number; appts: number; sold: number }>();
    for (const l of scoped) {
      const s = normalizeSource(l.source);
      const row = map.get(s) || { leads: 0, worked: 0, appts: 0, sold: 0 };
      row.leads += 1;
      if ((l.dials_count || 0) > 0 || l.last_contact_date) row.worked += 1;
      if (l.appointment_datetime || isAppointment(l.status, l.stage_bucket)) row.appts += 1;
      if (isClosedSold(l.status)) row.sold += 1;
      map.set(s, row);
    }
    return Array.from(map.entries())
      .map(([source, r]) => ({ source, ...r }))
      .sort((a, b) => b.leads - a.leads);
  }, [scoped]);

  const dataHealth = useMemo(() => {
    const noPhone = scoped.filter((l) => !l.phone && !l.phone2).length;
    const noBirthday = scoped.filter((l) => !l.birthday).length;
    const noEmail = scoped.filter((l) => !l.email).length;
    const dupes = scoped.filter((l) => l._dupe).length;
    // Split, because they mean opposite things: one is a suppression you must
    // honour, the other is a label on leads that stay in the queue.
    const dnc = scoped.filter((l) => askedNotToBeCalled(l)).length;
    const scrubbed = scoped.filter((l) => onScrubList(l)).length;
    return { noPhone, noBirthday, noEmail, dupes, dnc, scrubbed };
  }, [scoped]);

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-ink">Stats</h1>
        <p className="text-sm text-slate-500">{leadsLoading ? "Loading…" : `${who} scope`}</p>
      </div>

      <div className="mb-4 rounded-xl border border-line bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-ink">Today&apos;s dials</p>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>
              {callsTodayTotal} of {dialGoal} goal
            </span>
            <input
              type="number"
              min={1}
              value={dialGoal}
              onChange={(e) => saveGoal(Math.max(1, Number(e.target.value)))}
              className="w-16 rounded-md border border-line px-2 py-1 text-xs"
              title="Daily dial goal (team)"
            />
          </div>
        </div>
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-brand transition-all"
            style={{ width: `${Math.min(100, (callsTodayTotal / dialGoal) * 100)}%` }}
          />
        </div>
      </div>

      {/* Who did what, when it worked, and whether it's holding up. */}
      <ActivityStats />

      {/* The carrier call panel used to live here: answer rate, talk minutes
          and spend, with a dashed placeholder telling you to go add Telnyx
          secrets in Supabase. The dialer is retired and calls come off personal
          handsets, so those numbers can never arrive and the placeholder was
          sending anyone who read it to set up a system that no longer exists.
          Dial volume and contact rate still come from the activity log, in
          <ActivityStats/> directly above. */}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatCard label="Total leads" value={totals.total.toLocaleString()} />
        <StatCard label="Never dialed" value={totals.neverDialed.toLocaleString()} />
        <StatCard label="In nurture" value={totals.inNurture.toLocaleString()} sublabel="active sequences" />
        <StatCard label="Dials logged" value={totals.dialsLogged.toLocaleString()} sublabel="all-time, per app" />
        <StatCard label="Appointments" value={totals.appointments.toLocaleString()} />
        <StatCard label="Closed — sold" value={totals.closedSold.toLocaleString()} />
        <StatCard label="Overdue" value={totals.overdue.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Leads by source">
          <BarList data={bySource} />
        </ChartCard>

        <ChartCard title="Status distribution">
          <Donut data={byStatus} />
        </ChartCard>

        <ChartCard title="Open tasks by owner">
          {byAssignedTask.length > 0 ? (
            <Donut data={byAssignedTask} />
          ) : (
            <p className="py-8 text-center text-sm text-slate-400">
              No open assigned tasks yet. Plan an action and hand it to Christian or Will.
            </p>
          )}
        </ChartCard>

        <ChartCard title="Conversion funnel">
          <BarList data={funnel} />
        </ChartCard>
      </div>

      <div className="mt-4 rounded-xl border border-line bg-white p-4 shadow-card">
        <p className="mb-3 text-sm font-semibold text-ink">Appointment funnel</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xl font-semibold text-ink">{apptStats.set.toLocaleString()}</p>
            <p className="text-xs text-slate-500">set (ever)</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{apptStats.held.toLocaleString()}</p>
            <p className="text-xs text-slate-500">held</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{apptStats.noShow.toLocaleString()}</p>
            <p className="text-xs text-slate-500">no-show</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">
              {apptStats.showRate === null ? "—" : `${apptStats.showRate}%`}
            </p>
            <p className="text-xs text-slate-500">show rate</p>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-line bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-ink">Door knocking — last 90 days</p>
          <p className="text-xs text-slate-500">
            {knockStats.daysWorked} day{knockStats.daysWorked === 1 ? "" : "s"} worked
            {knockStats.todayCount > 0 ? ` · ${knockStats.todayCount} today` : ""}
          </p>
        </div>

        {knockStats.total === 0 ? (
          <p className="mt-3 text-sm text-later">
            No door knocks logged yet. Once you work a route in Door Knock mode, contact rate and
            appointments per 100 doors show up here — that&apos;s how you&apos;ll know whether
            knocking is beating the phone.
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div>
                <p className="text-xl font-semibold text-ink tabular-nums">{knockStats.total}</p>
                <p className="text-xs text-slate-500">doors knocked</p>
              </div>
              <div>
                <p className="text-xl font-semibold text-ink tabular-nums">
                  {knockStats.contactRate === null ? "—" : `${knockStats.contactRate}%`}
                </p>
                <p className="text-xs text-slate-500">someone answered</p>
              </div>
              <div>
                <p className="text-xl font-semibold text-ink tabular-nums">
                  {knockStats.apptsPer100 === null ? "—" : knockStats.apptsPer100}
                </p>
                <p className="text-xs text-slate-500">appts per 100 doors</p>
              </div>
              <div>
                <p className="text-xl font-semibold text-ink tabular-nums">{knockStats.perDay}</p>
                <p className="text-xs text-slate-500">doors per day worked</p>
              </div>
              <div>
                <p className="text-xl font-semibold text-ink tabular-nums">{knockStats.appts}</p>
                <p className="text-xs text-slate-500">appointments set</p>
              </div>
            </div>

            {dialCompare.contactRate !== null && knockStats.contactRate !== null && (
              <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-xs text-worked">
                Someone answers <strong>{knockStats.contactRate}%</strong> of doors versus{" "}
                <strong>{dialCompare.contactRate}%</strong> of dials (dials measured over the last 7
                days, so treat this as directional until both have real volume).
              </p>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
                  Outcomes
                </p>
                <BarList data={knockStats.byOutcome} />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
                  Doors by person
                </p>
                <BarList data={knockStats.byPerson} />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-line bg-white shadow-card">
        <p className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
          Source ROI — which channels convert
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">Leads</th>
                <th className="px-4 py-2 text-right font-medium">Worked</th>
                <th className="px-4 py-2 text-right font-medium">Appts</th>
                <th className="px-4 py-2 text-right font-medium">Sold</th>
                <th className="px-4 py-2 text-right font-medium">Worked→Appt</th>
              </tr>
            </thead>
            <tbody>
              {sourceROI.map((r) => (
                <tr key={r.source} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2 text-ink">{r.source}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{r.leads.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{r.worked.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{r.appts.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{r.sold.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right text-slate-600">
                    {r.worked ? `${Math.round((r.appts / r.worked) * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-line bg-white p-4 shadow-card">
        <p className="mb-3 text-sm font-semibold text-ink">Data health</p>
        {/* Every number that has somewhere to go, goes there. A dashboard that
            reports 104 duplicates and offers no way to reach them is just a
            reminder to feel bad. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div>
            <p className="text-xl font-semibold text-ink">{dataHealth.noPhone.toLocaleString()}</p>
            <p className="text-xs text-slate-500">no phone (uncallable)</p>
            <Link href="/knock/" className="text-[11px] font-medium text-brand hover:underline">
              Work them as doors
            </Link>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{dataHealth.noBirthday.toLocaleString()}</p>
            <p className="text-xs text-slate-500">no birthday (off T65 radar)</p>
            <Link href="/list/?seg=badinfo" className="text-[11px] font-medium text-brand hover:underline">
              Fix the records
            </Link>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{dataHealth.noEmail.toLocaleString()}</p>
            <p className="text-xs text-slate-500">no email</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{dataHealth.dupes.toLocaleString()}</p>
            <p className="text-xs text-slate-500">duplicate phone</p>
            <Link href="/list/?seg=dupes" className="text-[11px] font-medium text-brand hover:underline">
              Merge them
            </Link>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{dataHealth.dnc.toLocaleString()}</p>
            <p className="text-xs text-slate-500">asked not to be called</p>
            <Link href="/list/?seg=dnc" className="text-[11px] font-medium text-brand hover:underline">
              Review
            </Link>
          </div>
          <div>
            <p className="text-xl font-semibold text-ink">{dataHealth.scrubbed.toLocaleString()}</p>
            <p className="text-xs text-slate-500">on a DNC list (still callable)</p>
            <Link href="/list/?seg=scrublist" className="text-[11px] font-medium text-brand hover:underline">
              Review
            </Link>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Capturing a birthday moves a lead onto the T65 Radar and into the IEP priority boost.
          Capturing an email lets the Email steps in a sequence actually do something.
        </p>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Appointments and sold counts are read from the status/stage text you and Will type in, so keep
        those fields consistent when you log a call — the numbers here are only as accurate as what
        gets typed into the drawer.
      </p>
    </div>
  );
}
