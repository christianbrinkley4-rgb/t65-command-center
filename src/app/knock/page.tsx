"use client";

// Door-knock mode: a phone-first field page. Pick a town, walk the streets in
// order, one-tap the outcome at each door. Phone-DNC leads are INCLUDED on
// purpose — the door is the only compliant channel left for them.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DoorOpen,
  MapPin,
  Undo2,
  Phone,
  Navigation,
  ExternalLink,
  StickyNote,
  CalendarClock,
  Bookmark,
  Check,
} from "lucide-react";
import { useApp } from "@/lib/context";
import { supabase } from "@/lib/supabaseClient";
import {
  applyKnock,
  groupByHousehold,
  groupByStreet,
  multiUnitAddressKeys,
  KNOCK_OUTCOMES,
  type KnockOutcome,
  type Household,
} from "@/lib/knock";
import { homeValueSuspect, trustedHomeValue } from "@/lib/homeValue";
import { setAppointment } from "@/lib/dispositions";
import { scheduleFollowUp } from "@/lib/actions";
import { writeOrQueue } from "@/lib/offline";
import { logActivity, todayStr } from "@/lib/sequences";
import { iepPhase, monthsToBirthdayMonth } from "@/lib/priority";
import {
  planRoute,
  routeMiles,
  estimateMinutes,
  googleMapsLegs,
  haversineMiles,
  type Stop,
  type LatLng,
} from "@/lib/route";
import {
  clearCurrentRoute,
  deleteSavedRoute,
  loadCurrentRoute,
  loadSavedRoutes,
  newRouteId,
  putCurrentRoute,
  putSavedRoute,
  rehydrateRoute,
  remainingCount,
  savedAgo,
  suggestRouteName,
  type SavedRoute,
} from "@/lib/savedRoutes";
import RoutePlanner, { type RoutePlan } from "@/components/RoutePlanner";
import T65Badge from "@/components/T65Badge";
import MultiSelect from "@/components/MultiSelect";
import { birthMonth, MONTH_NAMES, MONTH_UNKNOWN, normalizeSource } from "@/lib/categories";
import {
  BAND_GROUPS,
  matchesOccupancy,
  matchesValueBand,
  OCCUPANCY_OPTIONS,
  VALUE_BANDS,
  type Occupancy,
} from "@/lib/valueBands";
import { ACTION_ASSIGNEES, askedNotToBeCalled, needsInfo } from "@/lib/types";
import type { ActionAssignee, LeadWithBucket } from "@/lib/types";

// datetime-local wants "YYYY-MM-DDTHH:MM" in LOCAL time — toISOString() would
// shift an evening follow-up onto the wrong day.
function dtLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function at(daysFromNow: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return dtLocal(d);
}

/** Tomorrow morning unless it's already evening — then the day after. */
function defaultFollowUp(): string {
  return at(1, 10);
}

// The times people actually name at a door. Evening first: that's when the
// working spouse is home, which is the usual reason to come back at all.
const FOLLOW_UP_PRESETS: Array<{ label: string; value: () => string }> = [
  { label: "Tonight 6pm", value: () => at(0, 18) },
  { label: "Tomorrow 10am", value: () => at(1, 10) },
  { label: "Tomorrow 6pm", value: () => at(1, 18) },
  { label: "In 3 days", value: () => at(3, 10) },
  { label: "Next week", value: () => at(7, 10) },
];

type KnockUndo = {
  key: string;
  name: string;
  queued: boolean;
  prior: Array<{ id: string } & Record<string, unknown>>;
};

export default function KnockPage() {
  const { leads, leadsLoading, me, reload } = useApp();
  // Multi-pick filters. An EMPTY array means "no restriction" — an untouched
  // filter must never hide a door.
  const [cities, setCities] = useState<string[]>([]);
  const [zips, setZips] = useState<string[]>([]);
  const [lists, setLists] = useState<string[]>([]); // source or tag — a lead can be on several
  const [months, setMonths] = useState<string[]>([]); // months they turn 65
  // Default skips the $750k+ doors. Those households have an advisor and a
  // gate; a cold knock is the wrong tool. They're still one tap away in their
  // own band, because that's annuity and LTC money, not junk.
  const [band, setBand] = useState("upto750");
  const [includeUnknownValue, setIncludeUnknownValue] = useState(true);
  const [occupancy, setOccupancy] = useState<Occupancy>("any");
  const [t65Filter, setT65Filter] = useState<"all" | "soon" | "iep">("all");
  const [phoneFilter, setPhoneFilter] = useState<"all" | "callable" | "dnc">("all");
  const [showKnockedToday, setShowKnockedToday] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [lastUndo, setLastUndo] = useState<KnockUndo | null>(null);
  const [apptFor, setApptFor] = useState<string | null>(null);
  const [apptWhen, setApptWhen] = useState("");
  const [streetLimit, setStreetLimit] = useState(25);
  // Optimized route state: null = list mode, [] = optimizing failed/empty
  const [route, setRoute] = useState<Stop[] | null>(null);
  const [routeStart, setRouteStart] = useState<{ lat: number; lng: number } | null>(null);
  // The finish point actually used. Not the same as routePlan.end: "back at
  // start" only becomes a real point once the start resolves.
  const [routeEnd, setRouteEnd] = useState<{ lat: number; lng: number } | null>(null);
  const [routeErr, setRouteErr] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  // "Near me": you're between appointments and want the closest doors, sorted
  // nearest-first, with a hard cap on how far you're willing to drive.
  const [radius, setRadius] = useState(0); // miles; 0 = off
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [watchId, setWatchId] = useState<number | null>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  // The written-down copy of the route. Set the moment one is built, updated as
  // doors get worked, and the thing the resume bar offers back. Non-null while
  // `route` is null means "you have a route waiting".
  const [routeRec, setRouteRec] = useState<SavedRoute | null>(null);
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([]);
  const [naming, setNaming] = useState(false);
  const [nameText, setNameText] = useState("");
  // Neutral status about the route itself (restored, doors dropped). Separate
  // from routeErr, which is red and means something went wrong.
  const [routeNote, setRouteNote] = useState<string | null>(null);
  // Per-door conversation note, captured at the door
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  // "Come back Tuesday at 6" — a scheduled return, day and time
  const [followFor, setFollowFor] = useState<string | null>(null);
  const [followWhen, setFollowWhen] = useState("");
  const [followNote, setFollowNote] = useState("");
  const [followWho, setFollowWho] = useState<ActionAssignee>("Either");

  // Changing a filter still drops you out of route view — you asked for a
  // different set of doors. It no longer destroys the route: `routeRec` keeps
  // it and the resume bar hands it straight back.
  useEffect(() => {
    setStreetLimit(25);
    setRoute(null);
    setRouteNote(null);
    setNaming(false);
  }, [cities, zips, lists, months, band, includeUnknownValue, occupancy, t65Filter]);

  // Keep the screen awake while a route or Near-me session is running. Nothing
  // kills field momentum like unlocking the phone at every door. Released as
  // soon as the session ends so it can't quietly drain the battery all day.
  useEffect(() => {
    const active = route !== null || radius > 0;
    let sentinel: { release: () => Promise<void>; released: boolean } | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<any> };
    };
    async function acquire() {
      if (!active || !nav.wakeLock) return;
      try {
        const s = await nav.wakeLock.request("screen");
        if (cancelled) {
          void s.release();
          return;
        }
        sentinel = s;
      } catch {
        // Denied or unsupported — not worth telling the agent about.
      }
    }
    // Re-acquire after the tab is backgrounded (the lock is dropped for us).
    const onVisible = () => {
      if (document.visibilityState === "visible" && active && !sentinel) void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
    };
  }, [route, radius]);

  // While Near-me is on, track position so the list re-sorts as you drive.
  // watchPosition (not a one-shot) is what makes this usable while moving.
  useEffect(() => {
    if (radius === 0) {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        setWatchId(null);
      }
      return;
    }
    if (!navigator.geolocation) {
      setRouteErr("This browser can't share location, so Near me is unavailable.");
      setRadius(0);
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setRouteErr(null);
      },
      () => setRouteErr("Location permission denied — allow it to use Near me."),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    setWatchId(id);
    return () => navigator.geolocation.clearWatch(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radius]);

  // Knockable book: has an address, door not off-limits, not a closed lead.
  // Phone-DNC and no-phone leads stay in — that's the point of knocking.
  const knockable = useMemo(
    () =>
      leads.filter(
        (l) =>
          (l.address || "").trim() !== "" &&
          !l.do_not_knock &&
          // Flagged as wrong info at a door — don't send anyone back to the
          // same bad address until the record is corrected.
          !needsInfo(l) &&
          !(l.stage_bucket === "Closed" || (l.status || "").startsWith("Closed"))
      ),
    [leads]
  );

  // Counts next to each option: you can see a ZIP holds 12 doors before you
  // pick it, instead of selecting it and watching the list go empty.
  const tally = (items: string[]) => {
    const m = new Map<string, number>();
    for (const k of items) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };

  const cityOptions = useMemo(() => {
    const counts = tally(knockable.map((l) => (l.city || "Unknown city").trim()));
    return Array.from(counts.keys())
      .sort()
      .map((c) => ({ value: c, label: c, count: counts.get(c) }));
  }, [knockable]);

  // Lists a door can belong to: where it came from (source) plus any list tag
  // added by a later import. One lead can appear under several.
  const listOptions = useMemo(() => {
    const counts = tally([
      ...knockable.map((l) => normalizeSource(l.source)),
      ...knockable.flatMap((l) => l.tags || []),
    ]);
    return Array.from(counts.keys())
      .sort()
      .map((v) => ({ value: v, label: v, count: counts.get(v) }));
  }, [knockable]);

  // ZIPs narrow to the towns you've picked, so the menu stays short.
  const zipOptions = useMemo(() => {
    const pool = cities.length
      ? knockable.filter((l) => cities.includes((l.city || "Unknown city").trim()))
      : knockable;
    const counts = tally(pool.map((l) => (l.zip || "").trim()).filter(Boolean));
    return Array.from(counts.keys())
      .sort()
      .map((z) => ({ value: z, label: z, count: counts.get(z) }));
  }, [knockable, cities]);

  const monthOptions = useMemo(() => {
    const counts = tally(
      knockable.map((l) => {
        const m = birthMonth(l.birthday);
        return m === null ? String(MONTH_UNKNOWN) : String(m);
      })
    );
    const out = MONTH_NAMES.map((name, i) => ({
      value: String(i + 1),
      label: `${name} birthdays`,
      count: counts.get(String(i + 1)) || 0,
    }));
    out.push({
      value: String(MONTH_UNKNOWN),
      label: "No birth month on file",
      count: counts.get(String(MONTH_UNKNOWN)) || 0,
    });
    return out;
  }, [knockable]);

  const filtered = useMemo(() => {
    let q = knockable;
    // Within one filter the picks are OR (Jan or Feb or March). Across filters
    // they are AND, so "Pleasant Garden, spring birthdays, 27313" is one route.
    if (cities.length) q = q.filter((l) => cities.includes((l.city || "Unknown city").trim()));
    if (zips.length) q = q.filter((l) => zips.includes((l.zip || "").trim()));
    if (lists.length)
      q = q.filter(
        (l) => lists.includes(normalizeSource(l.source)) || (l.tags || []).some((t) => lists.includes(t))
      );
    if (months.length)
      q = q.filter((l) => {
        const m = birthMonth(l.birthday);
        return months.includes(m === null ? String(MONTH_UNKNOWN) : String(m));
      });
    if (t65Filter === "iep")
      q = q.filter((l) => {
        const p = iepPhase(l.birthday);
        return p === "hot" || p === "birthday" || p === "closing";
      });
    if (t65Filter === "soon")
      q = q.filter((l) => {
        const m = monthsToBirthdayMonth(l.birthday);
        return m !== null && m <= 6;
      });
    if (phoneFilter === "callable") q = q.filter((l) => !askedNotToBeCalled(l) && (l.phone || l.phone2));
    if (phoneFilter === "dnc") q = q.filter((l) => askedNotToBeCalled(l));
    if (!showKnockedToday) q = q.filter((l) => l.last_knock_date !== todayStr());
    return q;
  }, [knockable, cities, zips, lists, months, t65Filter, phoneFilter, showKnockedToday]);

  // `done` is keyed by HOUSEHOLD, so the whole door leaves the list once it's
  // worked — filtering leads here would leave a spouse behind at the same address.
  const doors = useMemo(
    () => groupByHousehold(filtered).filter((h) => !done.has(h.key)),
    [filtered, done]
  );

  // Value and occupancy are judged per DOOR, not per lead. A couple shares one
  // parcel, so filtering leads would split a household and leave one spouse
  // standing on the list at an address the other was filtered out of.
  // Addresses that are really buildings. Computed over the whole book, not the
  // filtered view, so a filter can't make an apartment look like a house.
  const multiUnit = useMemo(() => multiUnitAddressKeys(leads), [leads]);

  // A value we don't believe is worth less than no value: it sorts and filters
  // as if it were real. Distrusted doors read as unpriced instead.
  const doorValue = (h: Household) =>
    Math.max(...h.occupants.map((o) => Number(trustedHomeValue(o, multiUnit.has(h.key)) || 0)), 0);
  const doorOwnerOccupied = (h: Household) => {
    const known = h.occupants.map((o) => o.home_owner_occupied).filter((v) => v != null);
    return known.length ? known.some((v) => v === true) : null;
  };

  const households = useMemo(
    () =>
      doors.filter(
        (h) =>
          matchesValueBand(doorValue(h), band, includeUnknownValue) &&
          matchesOccupancy(doorOwnerOccupied(h), occupancy)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doors, band, includeUnknownValue, occupancy]
  );

  // How many doors sit in each band, before the band filter runs. Shown in the
  // menu so you can see there are 412 doors under $500k without guessing.
  const bandCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of VALUE_BANDS) {
      counts[b.key] = doors.filter((h) => matchesValueBand(doorValue(h), b.key, includeUnknownValue)).length;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doors, includeUnknownValue]);

  // Doors we filtered out purely on price, so a shrunken list is explained.
  const pricedOut = doors.length - households.length;
  const groups = useMemo(() => groupByStreet(households), [households]);
  // Doors we can't route because the address never geocoded — surfaced so a
  // short route is explained rather than mysterious.
  const unmapped = useMemo(() => households.filter((h) => h.lat == null).length, [households]);

  // Near-me view: doors inside the radius, closest first. Overrides the
  // street grouping — when you have 20 minutes you want the next nearest door,
  // not a tidy walk down one street.
  const nearby = useMemo(() => {
    if (radius === 0 || !here) return null;
    return households
      .filter((h) => h.lat != null && h.lng != null)
      .map((h) => ({
        hh: h,
        miles: haversineMiles(here.lat, here.lng, h.lat as number, h.lng as number),
      }))
      .filter((x) => x.miles <= radius)
      .sort((a, b) => a.miles - b.miles);
  }, [households, radius, here]);


  // ── saved routes ───────────────────────────────────────────────────────────

  // Every door in the book, keyed the way a saved route stores it. Deliberately
  // built from `knockable` and NOT from the filtered list: a route you saved on
  // Tuesday has to come back on Thursday whatever the town filter says today.
  // What it does respect is the book — a door closed, marked do-not-knock, or
  // flagged wrong-info since you saved is gone, and should stay gone.
  const doorsByKey = useMemo(() => {
    const m = new Map<string, Household>();
    for (const h of groupByHousehold(knockable)) m.set(h.key, h);
    return m;
  }, [knockable]);

  const restoredRef = useRef(false);

  // Come back to a route you were already walking. Within half a day it just
  // reappears — you closed the tab at a door and reopened it at the same door,
  // and being asked to confirm that is noise. Older than that it waits in the
  // resume bar instead of ambushing you with last week's plan.
  useEffect(() => {
    if (restoredRef.current || leadsLoading) return;
    restoredRef.current = true;
    setSavedRoutes(loadSavedRoutes());
    const cur = loadCurrentRoute();
    if (!cur) return;
    setRouteRec(cur);
    // An empty book means the load failed or the cache is cold, not that the
    // route is finished. Leave it in the resume bar rather than telling someone
    // their doors are gone.
    if (doorsByKey.size === 0) return;
    const age = Date.now() - Date.parse(cur.savedAt);
    if (Number.isFinite(age) && age < 12 * 60 * 60 * 1000 && remainingCount(cur) > 0) {
      openRoute(cur, true);
    }
    // openRoute and doorsByKey are read once, on the first load with a book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadsLoading]);

  // Progress writes through on every knock. The alternative is a route that
  // remembers its doors but forgets which ones you did, which is the half of
  // the problem that actually costs you a re-knock.
  useEffect(() => {
    if (!routeRec || !route) return;
    const keys = new Set(route.map((s) => s.hh?.key).filter(Boolean) as string[]);
    const doneNow = [...done].filter((k) => keys.has(k));
    const was = new Set(routeRec.done);
    if (doneNow.length === was.size && doneNow.every((k) => was.has(k))) return;
    const next: SavedRoute = { ...routeRec, done: doneNow, savedAt: new Date().toISOString() };
    setRouteRec(next);
    putCurrentRoute(next);
    if (next.name) setSavedRoutes(putSavedRoute(next));
  }, [done, route, routeRec]);

  /**
   * Put a stored route back on screen. Returns false when there's nothing left
   * of it — every door worked or dropped out of the book — rather than showing
   * an empty route and letting the agent work out why.
   */
  function openRoute(rec: SavedRoute, quiet = false): boolean {
    const { stops, missing } = rehydrateRoute(rec, doorsByKey);
    if (stops.length === 0) {
      // Silent when we opened it ourselves — an error nobody asked for, on a
      // page they just opened, reads as a broken app.
      if (!quiet) {
        setRouteErr(
          "None of that route's doors are still on the list — they've been worked, closed, or marked do not knock."
        );
      }
      return false;
    }
    // Opening a route makes it the one you're on, which is what has to come
    // back if the app closes. Without this, opening Thursday's saved route and
    // then losing the tab would hand you back the route you'd abandoned before
    // it. The clock is restamped too, so a route you just picked up auto-
    // resumes — except on the quiet path, where restamping would keep an
    // abandoned route inside the 12-hour window forever.
    const opened: SavedRoute = quiet ? rec : { ...rec, savedAt: new Date().toISOString() };
    setRoute(stops);
    setRouteStart(opened.start);
    setRouteEnd(opened.end);
    setRoutePlan(opened.plan);
    setRouteRec(opened);
    putCurrentRoute(opened);
    setRouteErr(null);
    // Doors worked on the route stay marked as worked, so resuming shows you
    // where you stopped instead of making you remember it.
    setDone((prev) => {
      const n = new Set(prev);
      for (const k of opened.done) n.add(k);
      return n;
    });
    const left = stops.filter((s) => s.hh && !opened.done.includes(s.hh.key)).length;
    const parts: string[] = [];
    parts.push(quiet ? `Picked up where you left off — ${left} door${left === 1 ? "" : "s"} to go.` : `${left} door${left === 1 ? "" : "s"} still to knock.`);
    if (missing > 0) {
      parts.push(
        `${missing} door${missing === 1 ? " has" : "s have"} come off the list since you saved it.`
      );
    }
    setRouteNote(parts.join(" "));
    return true;
  }

  /** Pin the route you're on under a name, so the next build can't overwrite it. */
  function saveRouteAs(raw: string) {
    if (!routeRec) return;
    const name = raw.trim() || suggestRouteName(route || []);
    const rec: SavedRoute = { ...routeRec, name, savedAt: new Date().toISOString() };
    setRouteRec(rec);
    putCurrentRoute(rec);
    setSavedRoutes(putSavedRoute(rec));
    setNaming(false);
    setRouteNote(`Saved as "${name}". Open it from Plan route any time.`);
  }

  function forgetRoute(id: string) {
    setSavedRoutes(deleteSavedRoute(id));
    // Deleting the one you're on unpins it; it stays on screen and stays the
    // current route, it just stops being in the saved list.
    if (routeRec?.id === id) {
      const rec: SavedRoute = { ...routeRec, name: null };
      setRouteRec(rec);
      putCurrentRoute(rec);
    }
  }

  // One tap records the outcome for EVERY occupant of the house — a couple is
  // one front door, and marking only the husband leaves the wife in tomorrow's
  // queue at the same address.
  async function knock(hh: Household, o: KnockOutcome) {
    if (busy) return;
    setBusy(hh.key);
    setRouteErr(null);
    try {
      const prior = hh.occupants.map((l) => ({
        id: l.id,
        status: l.status,
        stage_bucket: l.stage_bucket,
        next_follow_up_date: l.next_follow_up_date,
        last_contact_date: l.last_contact_date,
        do_not_knock: l.do_not_knock ?? false,
        knock_count: l.knock_count || 0,
        last_knock_date: l.last_knock_date,
        needs_oscr_writeback: l.needs_oscr_writeback ?? false,
        oscr_writeback_note: l.oscr_writeback_note,
      }));
      let queued = false;
      for (const l of hh.occupants) {
        const res = await applyKnock(l as LeadWithBucket, o, me);
        if (res === "queued") queued = true;
      }
      setDone((set) => new Set(set).add(hh.key));
      setLastUndo({
        key: hh.key,
        name: `${hh.primary.name || "lead"} — ${o.label}`,
        queued,
        prior,
      });
    } catch (e) {
      // applyKnock queues rather than throwing, so reaching here means
      // something structural. Say so instead of looking like it worked.
      setRouteErr(
        e instanceof Error
          ? `Couldn't record that knock: ${e.message}. Try again.`
          : "Couldn't record that knock. Try again."
      );
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    if (!lastUndo || busy) return;
    setBusy(lastUndo.key);
    try {
      for (const p of lastUndo.prior) {
        const { id, ...fields } = p;
        await writeOrQueue({
          table: "leads",
          op: "update",
          match: { id },
          payload: { ...fields, updated_at: new Date().toISOString() },
          label: `Undo · ${lastUndo.name}`,
        });
        await writeOrQueue({
          table: "activity_log",
          op: "insert",
          payload: {
            lead_id: id,
            activity_type: "Undo",
            outcome: "Reverted last door knock",
            logged_by: me,
            activity_date: new Date().toISOString(),
          },
          label: `Undo log · ${lastUndo.name}`,
        });
      }
      setDone((set) => {
        const n = new Set(set);
        n.delete(lastUndo.key);
        return n;
      });
      setLastUndo(null);
    } finally {
      setBusy(null);
    }
  }

  // Append a dated note. Appending (never replacing) means a second visit
  // can't erase what happened on the first.
  async function saveNote(hh: Household) {
    const text = noteText.trim();
    if (!text || busy) return;
    setBusy(hh.key);
    setRouteErr(null);
    try {
      const stamp = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const entry = `[${stamp} door · ${me}] ${text}`;
      const lead = hh.primary;
      const prior = (lead.raw_notes || lead.notes || "").trim();
      const res = await writeOrQueue({
        table: "leads",
        op: "update",
        match: { id: lead.id },
        payload: {
          raw_notes: prior ? `${entry}
${prior}` : entry,
          updated_at: new Date().toISOString(),
        },
        label: `Note · ${lead.name || "lead"}`,
      });
      await writeOrQueue({
        table: "activity_log",
        op: "insert",
        payload: {
          lead_id: lead.id,
          activity_type: "Door Knock",
          outcome: "Note",
          notes: text,
          logged_by: me,
          activity_date: new Date().toISOString(),
        },
        label: `Note log · ${lead.name || "lead"}`,
      });
      setNoteFor(null);
      setNoteText("");
      if (res === "sent") await reload();
      else setRouteErr("Saved on this phone — it'll sync when you have signal.");
    } finally {
      setBusy(null);
    }
  }

  // A scheduled return, not a guess at "+3 days". The action carries the exact
  // time so the lead resurfaces at 6:15 on Tuesday, not somewhere on Tuesday.
  async function saveFollowUp(hh: Household) {
    if (!followWhen || busy) return;
    setBusy(hh.key);
    setRouteErr(null);
    try {
      const where = `${hh.primary.name || "lead"} — ${String(hh.address).split(",")[0]}`;
      const res = await scheduleFollowUp({
        leadId: hh.primary.id,
        leadLabel: where,
        when: followWhen,
        actionType: "Door Knock",
        note: followNote,
        assignee: followWho,
        me,
        extraLeadPatch: {
          knock_count: (hh.primary.knock_count || 0) + 1,
          last_knock_date: todayStr(),
        },
      });
      // The whole house was knocked, even though one action covers the door.
      for (const o of hh.occupants) {
        if (o.id !== hh.primary.id) {
          await writeOrQueue({
            table: "leads",
            op: "update",
            match: { id: o.id },
            payload: {
              knock_count: (o.knock_count || 0) + 1,
              last_knock_date: todayStr(),
              updated_at: new Date().toISOString(),
            },
            label: `Knocked · ${o.name || "lead"}`,
          });
        }
        await writeOrQueue({
          table: "activity_log",
          op: "insert",
          payload: {
            lead_id: o.id,
            activity_type: "Door Knock",
            outcome: "Follow-up scheduled",
            notes: followNote.trim() || null,
            logged_by: me,
            activity_date: new Date().toISOString(),
          },
          label: `Follow-up log · ${o.name || "lead"}`,
        });
      }
      setDone((set) => new Set(set).add(hh.key));
      setFollowFor(null);
      setFollowNote("");
      if (res === "queued") {
        setRouteErr("Follow-up saved on this phone — it'll sync when you have signal.");
      }
    } catch (e) {
      setRouteErr(
        `Follow-up did NOT save${e instanceof Error ? ` (${e.message})` : ""}. Write it down and re-enter it.`
      );
    } finally {
      setBusy(null);
    }
  }

  async function saveAppt(hh: Household) {
    if (!apptWhen || busy) return;
    setBusy(hh.key);
    setRouteErr(null);
    try {
      // An appointment is the one thing worth failing loudly about, so it goes
      // straight to the server rather than through the offline queue.
      await setAppointment(hh.primary as LeadWithBucket, apptWhen, me);
      await logActivity(hh.primary.id, "Door Knock", "Appointment set at the door", null, me);
      setDone((set) => new Set(set).add(hh.key));
      setApptFor(null);
      setApptWhen("");
    } catch (e) {
      setRouteErr(
        `Appointment did NOT save${e instanceof Error ? ` (${e.message})` : ""}. Write it down and re-enter it when you have signal.`
      );
    } finally {
      setBusy(null);
    }
  }

  const doorsLabel = `${households.length} door${households.length === 1 ? "" : "s"} · ${groups.length} street${groups.length === 1 ? "" : "s"}`;

  // Ask first (RoutePlanner), then build. The plan decides where the day ends,
  // how many doors, and the mileage ceiling — all three change the answer.
  function openPlanner() {
    setRouteErr(null);
    setPlannerOpen(true);
    // Warm up location while they're choosing, so Build is instant.
    if (navigator.geolocation && !here) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    }
  }

  function buildWithPlan(plan: RoutePlan) {
    setPlannerOpen(false);
    setRouteErr(null);
    setLocating(true);
    // A typed start needs no GPS at all — that's the point of it. Plan
    // tomorrow's route from the kitchen table, or start from an appointment
    // you haven't driven to yet.
    if (plan.start) {
      assembleRoute(plan.start, plan);
      return;
    }
    if (!navigator.geolocation) {
      setRouteErr(
        'This browser has no location access. Pick "A location" as your start to plan a route anyway.'
      );
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => assembleRoute({ lat: pos.coords.latitude, lng: pos.coords.longitude }, plan),
      (err) => {
        setRouteErr(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Allow it in your browser settings, or pick "A location" as your start.'
            : 'Couldn\'t get your location. Try again outside, or pick "A location" as your start.'
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  function assembleRoute(start: LatLng, plan: RoutePlan) {
    // "Back at start" resolves here, once the start is actually known.
    const end = plan.endAtStart ? start : plan.end;
    const all: Stop[] = households
      .filter((h) => h.lat != null && h.lng != null)
      .map((h) => ({ lead: h.primary, lat: h.lat as number, lng: h.lng as number, hh: h }));
    if (all.length === 0) {
      setRouteErr(
        "None of these doors have map coordinates yet. New imports geocode automatically; older leads need the geocode backfill."
      );
      setLocating(false);
      return;
    }

    // Which doors, not just what order. Nearest-to-start picks a ring of
    // scattered addresses; planRoute grows a pocket instead, so the door 300
    // feet from the one you just knocked comes next.
    const built = planRoute(all, {
      start,
      end,
      maxStops: plan.maxDoors,
      maxMiles: plan.maxMiles,
    });

    const finalMiles = routeMiles(start, built, end);
    if (built.length === 0) {
      setRouteErr("No doors fit that mileage limit. Try a bigger radius or more miles.");
      setLocating(false);
      return;
    }
    if (plan.maxMiles > 0 && finalMiles > plan.maxMiles + 0.05) {
      // The floor is the trip itself, not the doors — dropping more stops
      // wouldn't buy any miles back, so say why instead of silently obeying.
      setRouteErr(
        end
          ? `Getting to your finish point alone is about ${finalMiles.toFixed(1)} mi, over your ${plan.maxMiles} mi limit. These ${built.length} door${built.length === 1 ? "" : "s"} are on the way, so they cost nothing extra.`
          : `Nearest door is ${finalMiles.toFixed(1)} mi away, past your ${plan.maxMiles} mi limit. Showing it anyway.`
      );
    }
    setRouteStart(start);
    setRoutePlan(plan);
    setRouteEnd(end);
    setRoute(built);
    setLocating(false);
    setRouteNote(null);
    setNaming(false);
    // Written down before the first door. A route that only exists on screen is
    // a route you lose to a phone call.
    const rec: SavedRoute = {
      id: newRouteId(),
      name: null,
      savedAt: new Date().toISOString(),
      start,
      end: end ?? null,
      plan,
      stops: built.map((s) => s.hh?.key).filter(Boolean) as string[],
      done: [],
    };
    setRouteRec(rec);
    putCurrentRoute(rec);
  }

  const routeEndLabel = routePlan?.endAtStart
    ? routePlan.startLabel
      ? `back at ${routePlan.startLabel}`
      : "back where you started"
    : routePlan?.endLabel || null;

  // Doors on this route already knocked, counting the ones you did before you
  // closed the app as well as the ones from this sitting.
  const routeWorked = useMemo(
    () => (route ? route.filter((s) => s.hh && done.has(s.hh.key)).length : 0),
    [route, done]
  );

  const routeStats = useMemo(() => {
    if (!route || !routeStart || route.length === 0) return null;
    const miles = routeMiles(routeStart, route, routeEnd);
    return { miles: miles.toFixed(1), minutes: estimateMinutes(miles, route.length) };
  }, [route, routeStart, routeEnd]);

  /**
   * `worked` dims a door you've already knocked on this route. It stays fully
   * usable — you might disposition it again after a second conversation — but a
   * resumed route has to show at a glance where you stopped.
   */
  function renderCard(hh: Household, badge?: React.ReactNode, worked = false) {
    const lead = hh.primary as LeadWithBucket;
    const others = hh.occupants.filter((o) => o.id !== lead.id);
    // Occupants share a parcel, so the household's value is the best of them.
    const suspectValue = homeValueSuspect(hh.primary, multiUnit.has(hh.key));
    const hv = doorValue(hh);
    const anyDnc = hh.occupants.some((o) => askedNotToBeCalled(o));
    const knocks = Math.max(...hh.occupants.map((o) => o.knock_count || 0), 0);
    const lastKnock = hh.occupants.map((o) => o.last_knock_date).filter(Boolean).sort().pop();
    const dialable = hh.occupants.find((o) => o.phone);
    const mapsUrl =
      "https://maps.google.com/?q=" +
      encodeURIComponent(hh.address + ", " + (hh.city || "") + " NC " + (lead.zip || ""));
    const noteHistory = (lead.raw_notes || lead.notes || "").trim();

    return (
      <article
        key={hh.key}
        className={
          worked
            ? "rounded-2xl border border-line bg-white p-3.5 opacity-60 shadow-card"
            : "rounded-2xl border border-line bg-white p-3.5 shadow-card"
        }
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
              {badge}
              <span className="truncate">{lead.name || "Unnamed"}</span>
            </p>
            {others.length > 0 && (
              <p className="truncate text-xs text-worked">
                also here: {others.map((o) => o.name || "unnamed").join(", ")}
              </p>
            )}
            <a
              href={mapsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 flex items-center gap-1 text-sm text-brand underline-offset-2 hover:underline"
            >
              <MapPin size={13} className="shrink-0" aria-hidden />
              <span className="truncate">{String(hh.address).split(",")[0]}</span>
            </a>
            <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
              {hv > 0 && (
                <span className="rounded-md bg-paper px-1.5 py-0.5 font-medium text-worked">
                  ${Math.round(hv / 1000)}k home
                </span>
              )}
              {/* Say WHY there's no value. A blank reads as "not checked yet",
                  which sends you back to re-run enrichment on a building. */}
              {suspectValue && (
                <span className="rounded-md bg-week/10 px-1.5 py-0.5 font-medium text-week">
                  {suspectValue} — value not this home&apos;s
                </span>
              )}
              {/* Always show when they turn 65 — a neighborhood list is mostly
                  a year out, and the phase badge alone leaves those unlabeled.
                  Verbose at the door: no hover, no time to decode a colour. */}
              <T65Badge birthday={lead.birthday} verbose />

              {anyDnc && (
                <span className="rounded-md bg-due-50 px-1.5 py-0.5 font-medium text-due">
                  Phone DNC — knock first
                </span>
              )}
              {knocks > 0 && (
                <span className="rounded-md bg-paper px-1.5 py-0.5 text-later">
                  Knocked {knocks}x{lastKnock ? " · last " + lastKnock : ""}
                </span>
              )}
              {hh.lat == null && (
                <span className="rounded-md bg-week/10 px-1.5 py-0.5 font-medium text-week">
                  not on the map
                </span>
              )}
            </p>
          </div>
          {dialable?.phone && (
            <a
              href={"tel:" + dialable.phone}
              className={
                askedNotToBeCalled(dialable)
                  ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-due/40 bg-due-50 text-due"
                  : "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line text-worked hover:bg-paper"
              }
              title={
                askedNotToBeCalled(dialable)
                  ? dialable.phone + " — this person asked not to be called."
                  : String(dialable.phone)
              }
            >
              <Phone size={16} aria-hidden />
            </a>
          )}
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {KNOCK_OUTCOMES.map((o) => (
            <button
              key={o.key}
              onClick={() => knock(hh, o)}
              disabled={busy === hh.key}
              className={
                o.key === "dnk"
                  ? "min-h-11 rounded-xl border border-due/40 bg-due-50 px-1 py-2 text-xs font-medium text-due active:scale-[0.98] disabled:opacity-50"
                  : "min-h-11 rounded-xl border border-line bg-paper px-1 py-2 text-xs font-medium text-worked active:scale-[0.98] disabled:opacity-50"
              }
            >
              {o.label.replace("Talked - ", "")}
            </button>
          ))}
        </div>

        {apptFor === hh.key ? (
          <div className="mt-1.5 flex gap-1.5">
            <input
              type="datetime-local"
              value={apptWhen}
              onChange={(e) => setApptWhen(e.target.value)}
              aria-label="Appointment date and time"
              className="min-h-11 flex-1 rounded-xl border border-line px-2 text-sm"
            />
            <button
              onClick={() => saveAppt(hh)}
              disabled={!apptWhen || busy === hh.key}
              className="min-h-11 rounded-xl bg-newlead px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => {
                setApptFor(null);
                setApptWhen("");
              }}
              aria-label="Cancel appointment entry"
              className="min-h-11 rounded-xl border border-line px-3 text-sm text-worked"
            >
              &#10005;
            </button>
          </div>
        ) : (
          <div className="mt-1.5 grid grid-cols-4 gap-1.5">
            <button
              onClick={() => setApptFor(hh.key)}
              className="col-span-2 min-h-11 rounded-xl bg-brand px-2 py-2 text-sm font-semibold text-white active:scale-[0.99]"
            >
              Set appointment
            </button>
            <button
              onClick={() => {
                setFollowFor(followFor === hh.key ? null : hh.key);
                setFollowWhen(defaultFollowUp());
                setFollowNote("");
              }}
              aria-label={"Schedule a follow-up for " + (lead.name || "this lead")}
              className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-brand/40 bg-brand-light/50 px-1 text-xs font-semibold text-brand-dark active:scale-[0.98]"
            >
              <CalendarClock size={14} aria-hidden /> Follow up
            </button>
            <button
              onClick={() => {
                setNoteFor(noteFor === hh.key ? null : hh.key);
                setNoteText("");
              }}
              aria-label={"Add a note for " + (lead.name || "this lead")}
              className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-line bg-paper px-1 text-xs font-medium text-worked active:scale-[0.98]"
            >
              <StickyNote size={14} aria-hidden /> Note
            </button>
          </div>
        )}

        {/* "Come back Tuesday after 6" — the day AND the time, because that's
            what people actually say, and a date alone loses half of it. */}
        {followFor === hh.key && (
          <div className="mt-1.5 rounded-xl border border-brand/30 bg-brand-light/25 p-2">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-later">
              Come back when?
            </label>
            <input
              type="datetime-local"
              value={followWhen}
              onChange={(e) => setFollowWhen(e.target.value)}
              aria-label="Follow-up date and time"
              className="min-h-11 w-full rounded-xl border border-line bg-white px-2.5 text-sm"
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {FOLLOW_UP_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setFollowWhen(p.value())}
                  className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] text-worked active:scale-[0.98]"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <input
                value={followNote}
                onChange={(e) => setFollowNote(e.target.value)}
                aria-label="Follow-up note"
                placeholder="Wife's home after 6, bring the Plan G sheet…"
                className="min-h-11 flex-1 rounded-xl border border-line px-2.5 text-sm outline-none focus:border-brand"
              />
              <select
                value={followWho}
                onChange={(e) => setFollowWho(e.target.value as ActionAssignee)}
                aria-label="Who handles this follow-up"
                className="min-h-11 rounded-xl border border-line bg-white px-2 text-xs text-worked"
              >
                {ACTION_ASSIGNEES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button
                onClick={() => saveFollowUp(hh)}
                disabled={!followWhen || busy === hh.key}
                className="min-h-11 flex-1 rounded-xl bg-brand px-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Save follow-up
              </button>
              <button
                onClick={() => setFollowFor(null)}
                className="min-h-11 rounded-xl border border-line px-3 text-sm text-worked"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* What was actually said at the door. Saving a note does NOT drop the
            card — you may still want to disposition it afterwards. */}
        {noteFor === hh.key && (
          <div className="mt-1.5 rounded-xl border border-line bg-paper/60 p-2">
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
              autoFocus
              aria-label="Conversation note"
              placeholder="Wife handles insurance, come back after 5. On a group plan til March..."
              className="w-full rounded-lg border border-line px-2.5 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            {noteHistory && (
              <p className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap text-[11px] leading-snug text-later">
                {noteHistory}
              </p>
            )}
            <div className="mt-1.5 flex gap-1.5">
              <button
                onClick={() => saveNote(hh)}
                disabled={!noteText.trim() || busy === hh.key}
                className="min-h-11 flex-1 rounded-xl bg-newlead px-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Save note
              </button>
              <button
                onClick={() => {
                  setNoteFor(null);
                  setNoteText("");
                }}
                className="min-h-11 rounded-xl border border-line px-3 text-sm text-worked"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="mx-auto max-w-2xl pb-24">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Door Knock</h1>
          <p className="text-sm text-worked tabular-nums">{leadsLoading ? "Loading…" : doorsLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          {route === null ? (
            <button
              onClick={openPlanner}
              disabled={locating || households.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              <Navigation size={13} aria-hidden />
              {locating ? "Building…" : "Plan route"}
            </button>
          ) : (
            <button
              onClick={() => {
                setRoute(null);
                setRouteNote(null);
                setNaming(false);
              }}
              className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-worked hover:bg-paper"
            >
              Back to street list
            </button>
          )}
          <button
            onClick={() => {
              setDone(new Set());
              setRoute(null);
              reload();
            }}
            className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-worked hover:bg-paper"
          >
            Refresh
          </button>
        </div>
      </div>

      {routeErr && (
        <p role="alert" className="mb-3 rounded-xl border border-overdue/40 bg-overdue-50 px-3.5 py-2.5 text-xs text-overdue">
          {routeErr}
        </p>
      )}

      {routeNote && (
        <p className="mb-3 rounded-xl border border-line bg-white px-3.5 py-2.5 text-xs text-worked">
          {routeNote}
        </p>
      )}

      {/* The route you were walking, waiting to be picked back up. Shows on
          every path out of route view — a filter tap, "back to street list", a
          reload, the tab being closed — so a planned route is never something
          you have to rebuild from memory. */}
      {route === null && routeRec && !leadsLoading && remainingCount(routeRec) > 0 && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-brand/30 bg-brand-light/40 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold text-ink">
              {routeRec.name || "Your last route"}
            </p>
            <p className="text-xs text-worked tabular-nums">
              {remainingCount(routeRec)} of {routeRec.stops.length} door
              {routeRec.stops.length === 1 ? "" : "s"} left · {savedAgo(routeRec.savedAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => openRoute(routeRec)}
              className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-dark"
            >
              Resume
            </button>
            <button
              onClick={() => {
                clearCurrentRoute();
                setRouteRec(null);
                setRouteNote(null);
              }}
              aria-label="Discard the unfinished route"
              className="rounded-lg border border-line bg-white px-2.5 py-2 text-xs text-worked hover:bg-paper"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {pricedOut > 0 && (
        <p className="mb-3 text-[11px] text-later">
          {pricedOut.toLocaleString()} door{pricedOut === 1 ? "" : "s"} hidden by the value and
          occupancy filters. {band === "upto750" ? "Houses over $750k are their own band — worth a call about an annuity, not a cold knock." : ""}
        </p>
      )}

      {unmapped > 0 && (
        <p className="mb-3 text-[11px] text-later">
          {unmapped} of these doors have no map position (PO boxes, or an address the county
          couldn&apos;t match), so they appear in the street list but never in a route.
        </p>
      )}

      {/* One tap for the door that actually buys: a house in the range, an
          owner who lives in it, and a 65th birthday close enough to matter. */}
      <div className="mb-2 flex gap-2">
        <button
          onClick={() => {
            setBand("upto500");
            setOccupancy("owner");
            setT65Filter("soon");
            setIncludeUnknownValue(true);
          }}
          className="flex-1 rounded-xl border border-brand bg-brand-light px-3 py-2.5 text-sm font-semibold text-brand-dark active:scale-[0.99]"
        >
          Best doors
        </button>
        <button
          onClick={() => {
            setBand("any");
            setOccupancy("any");
            setT65Filter("all");
            setPhoneFilter("all");
            setCities([]);
            setZips([]);
            setLists([]);
            setMonths([]);
            setIncludeUnknownValue(true);
          }}
          className="rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-worked active:scale-[0.98]"
        >
          Clear filters
        </button>
      </div>

      {/* Field filters — big touch targets, minimal typing */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        <MultiSelect
          label="town"
          allLabel="All towns"
          options={cityOptions}
          selected={cities}
          onChange={(next) => {
            setCities(next);
            // Drop ZIPs that don't exist in the towns you just chose — checked
            // against the NEW towns, not the memo, which hasn't recomputed yet.
            setZips((z) =>
              z.filter(
                (v) =>
                  next.length === 0 ||
                  knockable.some(
                    (l) =>
                      next.includes((l.city || "Unknown city").trim()) && (l.zip || "").trim() === v
                  )
              )
            );
          }}
        />
        <MultiSelect label="ZIP" allLabel="All ZIPs" options={zipOptions} selected={zips} onChange={setZips} />
        <MultiSelect label="list" allLabel="All lists" options={listOptions} selected={lists} onChange={setLists} />
        <MultiSelect
          label="month"
          allLabel="Any birth month"
          options={monthOptions}
          selected={months}
          onChange={setMonths}
          searchable={false}
        />
        {/* What are we knocking? Counts are live, so you can see the band is
            worth a trip before you drive to it. */}
        <select
          aria-label="Filter by home value"
          value={band}
          onChange={(e) => setBand(e.target.value)}
          className={
            band === "any"
              ? "rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink"
              : "rounded-xl border border-brand bg-brand-light px-3 py-2.5 text-sm font-semibold text-brand-dark"
          }
        >
          {BAND_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {VALUE_BANDS.filter((b) => b.group === g).map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                  {bandCounts[b.key] != null ? ` (${bandCounts[b.key]})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          aria-label="Filter by who lives there"
          value={occupancy}
          onChange={(e) => setOccupancy(e.target.value as Occupancy)}
          className="rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink"
        >
          {OCCUPANCY_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by phone status"
          value={phoneFilter}
          onChange={(e) => setPhoneFilter(e.target.value as "all" | "callable" | "dnc")}
          className="rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink"
        >
          <option value="all">All phones</option>
          <option value="callable">Callable only</option>
          <option value="dnc">Phone DNC only</option>
        </select>
        <select
          aria-label="Filter by when they turn 65"
          value={t65Filter}
          onChange={(e) => setT65Filter(e.target.value as "all" | "soon" | "iep")}
          className="rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink"
        >
          <option value="all">Any T65 date</option>
          <option value="soon">Turns 65 within 6 mo</option>
          <option value="iep">IEP window open</option>
        </select>
        <select
          aria-label="Show only doors near me"
          value={radius}
          onChange={(e) => {
            setRadius(Number(e.target.value));
            setRoute(null);
          }}
          className={
            radius > 0
              ? "rounded-xl border border-brand bg-brand-light px-3 py-2.5 text-sm font-semibold text-brand-dark"
              : "rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink"
          }
        >
          <option value={0}>Anywhere</option>
          <option value={0.25}>Near me · ¼ mi</option>
          <option value={0.5}>Near me · ½ mi</option>
          <option value={1}>Near me · 1 mi</option>
          <option value={2}>Near me · 2 mi</option>
          <option value={5}>Near me · 5 mi</option>
        </select>
        <label className="flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-xs text-worked">
          <input
            type="checkbox"
            checked={showKnockedToday}
            onChange={(e) => setShowKnockedToday(e.target.checked)}
          />
          Show knocked today
        </label>
        {/* Only matters once a band is picked, and it matters a lot: hundreds
            of doors have never been priced. */}
        {band !== "any" && band !== "unknown" && (
          <label className="flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-xs text-worked">
            <input
              type="checkbox"
              checked={includeUnknownValue}
              onChange={(e) => setIncludeUnknownValue(e.target.checked)}
            />
            Keep unpriced doors
          </label>
        )}
      </div>

      {lastUndo && (
        <div role="status" className="mb-3 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2.5 text-sm shadow-card">
          <span className="truncate text-worked">Logged {lastUndo.name}</span>
          <button
            onClick={undo}
            disabled={!!busy}
            className="ml-2 flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-worked hover:bg-paper disabled:opacity-50"
          >
            <Undo2 size={13} /> Undo
          </button>
        </div>
      )}

      {/* Near me — the gap-time view: closest door first, re-sorts as you drive */}
      {radius > 0 && route === null && (
        <div className="mb-4">
          <div className="mb-3 flex items-center justify-between rounded-2xl border border-brand/30 bg-brand-light/40 px-4 py-3">
            <div>
              <p className="font-display text-base font-semibold text-ink">
                {here
                  ? `${nearby?.length ?? 0} door${nearby?.length === 1 ? "" : "s"} within ${radius} mi`
                  : "Finding your location…"}
              </p>
              <p className="text-xs text-worked">
                {here
                  ? "Closest first. Knock it, tap the result, the next one moves up."
                  : "Allow location access to see the doors around you."}
              </p>
            </div>
            <Navigation size={18} className="shrink-0 text-brand" aria-hidden />
          </div>

          {nearby && nearby.length > 0 && (
            <div className="space-y-2">
              {nearby.slice(0, 40).map(({ hh, miles }) =>
                renderCard(
                  hh,
                  <span className="shrink-0 rounded-md bg-brand px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-white">
                    {miles < 0.19 ? `${Math.round(miles * 5280)} ft` : `${miles.toFixed(1)} mi`}
                  </span>
                )
              )}
            </div>
          )}

          {here && nearby && nearby.length === 0 && (
            <div className="rounded-2xl border border-line bg-white p-8 text-center shadow-card">
              <DoorOpen className="mx-auto mb-2 text-later" size={22} aria-hidden />
              <p className="text-sm text-later">
                No doors within {radius} mi that match your other filters. Widen the radius, or clear
                the town and value filters.
              </p>
            </div>
          )}
        </div>
      )}

      {route !== null && routeStart && (
        <div className="mb-4">
          <div className="mb-3 rounded-2xl border border-line bg-white p-4 shadow-card">
            <p className="font-display text-base font-semibold text-ink">
              {routeRec?.name ? `${routeRec.name} · ` : ""}
              {route.length} stop{route.length === 1 ? "" : "s"}
              {routePlan?.startLabel ? ` · from ${routePlan.startLabel}` : ""}
              {routeEndLabel ? ` · ending ${routeEndLabel}` : ""}
            </p>
            {routeStats && (
              <p className="mt-0.5 text-sm text-worked tabular-nums">
                ~{routeStats.miles} mi driving · ~{routeStats.minutes} min door to door
                {routePlan && routePlan.maxMiles > 0 ? ` · limit ${routePlan.maxMiles} mi` : ""}
                {routeWorked > 0 ? ` · ${routeWorked} worked` : ""}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {googleMapsLegs(routeStart, route, routeEnd, routePlan?.endAddress || undefined).map(
                (leg) => (
                  <a
                    key={leg.url}
                    href={leg.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-dark"
                  >
                    <ExternalLink size={12} aria-hidden />
                    {leg.label}
                  </a>
                )
              )}
              <button
                onClick={() => {
                  setNaming(true);
                  setNameText(routeRec?.name || suggestRouteName(route));
                }}
                className={
                  routeRec?.name
                    ? "flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand-light/60 px-3 py-2 text-xs font-semibold text-brand-dark"
                    : "flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-xs text-worked hover:bg-paper"
                }
              >
                <Bookmark size={12} aria-hidden />
                {routeRec?.name ? "Saved" : "Save route"}
              </button>
              <button
                onClick={openPlanner}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-xs text-worked hover:bg-paper"
              >
                Change plan
              </button>
            </div>

            {/* Naming it is what makes it survive the next build. Everything
                else about the route is already written down. */}
            {naming && (
              <div className="mt-2 rounded-xl border border-brand/30 bg-brand-light/25 p-2">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-later">
                  Call this route
                </label>
                <div className="flex gap-1.5">
                  <input
                    value={nameText}
                    onChange={(e) => setNameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveRouteAs(nameText);
                    }}
                    autoFocus
                    aria-label="Name for this saved route"
                    placeholder="Pleasant Garden · Thursday"
                    className="min-h-11 flex-1 rounded-xl border border-line bg-white px-2.5 text-sm outline-none focus:border-brand"
                  />
                  <button
                    onClick={() => saveRouteAs(nameText)}
                    className="min-h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-white"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setNaming(false)}
                    aria-label="Cancel saving this route"
                    className="min-h-11 rounded-xl border border-line px-3 text-sm text-worked"
                  >
                    &#10005;
                  </button>
                </div>
              </div>
            )}

            <p className="mt-2 text-[11px] text-later">
              Doors chosen as the tightest pocket on your way, then ordered for the shortest drive.
              Straight-line miles, so the real drive runs a little longer. This route is kept as you
              work it — close the app, change a filter, come back and pick it up.
            </p>
          </div>
          <div className="space-y-2">
            {route.map((s, idx) => {
              const prev = idx === 0 ? routeStart : { lat: route[idx - 1].lat, lng: route[idx - 1].lng };
              const leg = haversineMiles(prev.lat, prev.lng, s.lat, s.lng);
              if (!s.hh) return null;
              const worked = done.has(s.hh.key);
              return renderCard(
                s.hh,
                <span
                  className={
                    worked
                      ? "flex shrink-0 items-center gap-0.5 rounded-md bg-newlead px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-white"
                      : "shrink-0 rounded-md bg-night px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-paper"
                  }
                >
                  {worked && <Check size={11} strokeWidth={3} aria-hidden />}
                  {idx + 1}
                  <span className={worked ? "ml-1 font-normal" : "ml-1 font-normal text-night-soft"}>
                    {leg.toFixed(1)}mi
                  </span>
                </span>,
                worked
              );
            })}
          </div>
        </div>
      )}

      {route === null && radius === 0 && groups.slice(0, streetLimit).map((g) => (
        <section key={`${g.city}|${g.street}`} className="mb-4">
          <h2 className="sticky top-14 z-10 mb-1.5 flex items-baseline gap-2 rounded-lg bg-paper/95 px-1 py-1 backdrop-blur">
            <span className="font-display text-base font-semibold text-ink">{g.street}</span>
            <span className="text-xs text-later">
              {g.city} · {g.households.length}
            </span>
          </h2>
          <div className="space-y-2">
            {g.households.map((h) => renderCard(h))}
          </div>
        </section>
      ))}

      {route === null && radius === 0 && streetLimit < groups.length && (
        <button
          onClick={() => setStreetLimit((v) => v + 25)}
          className="mb-4 w-full rounded-xl border border-line bg-white py-3 text-sm text-worked hover:bg-paper"
        >
          Show {Math.min(25, groups.length - streetLimit)} more streets ({groups.length - streetLimit} left)
        </button>
      )}

      {route === null && radius === 0 && !leadsLoading && households.length === 0 && (
        <div className="rounded-2xl border border-line bg-white p-10 text-center shadow-card">
          <DoorOpen className="mx-auto mb-2 text-later" size={24} />
          <p className="text-sm text-later">
            No doors match these filters. Widen the town/value filters, or every door here has been
            knocked today.
          </p>
        </div>
      )}
      <RoutePlanner
        open={plannerOpen}
        start={here}
        doorsAvailable={households.filter((h) => h.lat != null).length}
        saved={savedRoutes}
        onOpenSaved={(r) => {
          if (openRoute(r)) setPlannerOpen(false);
        }}
        onDeleteSaved={forgetRoute}
        onCancel={() => setPlannerOpen(false)}
        onBuild={buildWithPlan}
      />
    </div>
  );
}
