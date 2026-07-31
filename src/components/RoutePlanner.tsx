"use client";

// The "before you walk out the door" dialog: where does the route start and
// end, how many doors do you want, and how far are you willing to drive.
// Everything the optimizer needs, asked once, in the order you'd actually
// decide it.

import { useEffect, useRef, useState } from "react";
import { X, MapPin, LoaderCircle, Star } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import type { LatLng } from "@/lib/route";

export type RoutePlan = {
  // null start = "wherever I am right now"; the page resolves it from GPS at
  // build time rather than here, so a slow fix never blocks the dialog.
  start: LatLng | null;
  startLabel: string | null;
  end: LatLng | null;
  endLabel: string | null;
  // The geocodable address behind endLabel, for the Google Maps destination.
  // endLabel is prose and must never be used for that.
  endAddress: string | null;
  // Finish where the route started, whatever that turns out to be. Kept as a
  // flag instead of copying the point so it still works when the start is GPS
  // and hasn't resolved yet.
  endAtStart: boolean;
  maxDoors: number; // 0 = no cap
  maxMiles: number; // 0 = no cap
};

export type SavedPlace = { label: string; address: string; lat: number; lng: number };

const PLACES_KEY = "t65-places";

export function loadPlaces(): SavedPlace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PLACES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function savePlace(p: SavedPlace) {
  const existing = loadPlaces().filter(
    (x) => x.address.toLowerCase() !== p.address.toLowerCase()
  );
  localStorage.setItem(PLACES_KEY, JSON.stringify([p, ...existing].slice(0, 6)));
}

const DOOR_OPTIONS = [5, 10, 15, 20, 30, 0];
const MILE_OPTIONS = [3, 5, 10, 20, 0];

type StartMode = "here" | "address";
type EndMode = "anywhere" | "start" | "address";

export default function RoutePlanner({
  open,
  start,
  doorsAvailable,
  onCancel,
  onBuild,
}: {
  open: boolean;
  start: LatLng | null;
  doorsAvailable: number;
  onCancel: () => void;
  onBuild: (plan: RoutePlan) => void;
}) {
  const [startMode, setStartMode] = useState<StartMode>("here");
  const [startAddress, setStartAddress] = useState("");
  const [endMode, setEndMode] = useState<EndMode>("anywhere");
  const [address, setAddress] = useState("");
  const [maxDoors, setMaxDoors] = useState(10);
  const [maxMiles, setMaxMiles] = useState(10);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [resolving, setResolving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setPlaces(loadPlaces());
      setErr(null);
      setResolving(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  /**
   * Turn a typed address into a point, reusing a saved place when we already
   * have it so a known office/home costs no network round trip. Throws with a
   * message meant to be shown to someone standing on a sidewalk.
   */
  async function resolveAddress(raw: string, what: "start from" | "finish at"): Promise<SavedPlace> {
    const q = raw.trim();
    if (!q) throw new Error(`Type an address to ${what}, or pick a saved place.`);
    const hit = places.find((p) => p.address.toLowerCase() === q.toLowerCase());
    if (hit) return hit;
    const { data, error } = await supabase.functions.invoke("geocode", { body: { oneline: q } });
    if (error) throw new Error("Address lookup failed. Check your signal and try again.");
    if (!data?.point) {
      throw new Error("Couldn't find that address. Add the city, or try a nearby cross street.");
    }
    const place: SavedPlace = {
      label: q.split(",")[0].trim(),
      address: q,
      lat: data.point.lat,
      lng: data.point.lng,
    };
    savePlace(place);
    return place;
  }

  async function build() {
    setErr(null);
    setResolving(true);
    try {
      let startPoint: LatLng | null = null;
      let startLabel: string | null = null;
      if (startMode === "address") {
        const p = await resolveAddress(startAddress, "start from");
        startPoint = { lat: p.lat, lng: p.lng };
        startLabel = p.label;
      }

      let endPoint: LatLng | null = null;
      let endLabel: string | null = null;
      let endAddress: string | null = null;
      if (endMode === "address") {
        const p = await resolveAddress(address, "finish at");
        endPoint = { lat: p.lat, lng: p.lng };
        endLabel = p.label;
        endAddress = p.address;
      }

      onBuild({
        start: startPoint,
        startLabel,
        end: endPoint,
        endLabel,
        endAddress,
        endAtStart: endMode === "start",
        maxDoors,
        maxMiles,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setResolving(false);
    }
  }

  const chip = (active: boolean) =>
    active
      ? "rounded-xl bg-brand px-3 py-2.5 text-sm font-semibold text-white"
      : "rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-worked hover:bg-paper";

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Plan your door-knock route"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift sm:rounded-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold text-ink">Plan your route</h2>
            <p className="mt-0.5 text-sm text-worked">
              {doorsAvailable.toLocaleString()} door{doorsAvailable === 1 ? "" : "s"} match your
              current filters.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* 1. Where does it start */}
        <fieldset className="mb-4">
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
            Where do you start?
          </legend>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => setStartMode("here")} className={chip(startMode === "here")}>
              Current location
            </button>
            <button onClick={() => setStartMode("address")} className={chip(startMode === "address")}>
              A location
            </button>
          </div>
          {startMode === "address" && (
            <div className="mt-2">
              <input
                value={startAddress}
                onChange={(e) => setStartAddress(e.target.value)}
                aria-label="Address to start from"
                placeholder="Office, first appointment, home…"
                className="w-full rounded-xl border border-line px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
              {places.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {places.map((p) => (
                    <button
                      key={p.address}
                      onClick={() => setStartAddress(p.address)}
                      className="flex items-center gap-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-worked hover:bg-white"
                    >
                      <Star size={11} aria-hidden /> {p.label}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[11px] text-later">
                Plan tomorrow's route from the couch, or start from your next appointment.
              </p>
            </div>
          )}
          {startMode === "here" && !start && (
            <p className="mt-1 text-[11px] text-later">Still finding your location…</p>
          )}
        </fieldset>

        {/* 2. Where does it end */}
        <fieldset className="mb-4">
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
            Where do you finish?
          </legend>
          <div className="grid grid-cols-3 gap-1.5">
            <button onClick={() => setEndMode("anywhere")} className={chip(endMode === "anywhere")}>
              Anywhere
            </button>
            <button onClick={() => setEndMode("start")} className={chip(endMode === "start")}>
              Back at start
            </button>
            <button onClick={() => setEndMode("address")} className={chip(endMode === "address")}>
              An address
            </button>
          </div>
          {endMode === "address" && (
            <div className="mt-2">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                aria-label="Address to finish at"
                placeholder="Office, next appointment, home…"
                className="w-full rounded-xl border border-line px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
              {places.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {places.map((p) => (
                    <button
                      key={p.address}
                      onClick={() => setAddress(p.address)}
                      className="flex items-center gap-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-worked hover:bg-white"
                    >
                      <Star size={11} aria-hidden /> {p.label}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[11px] text-later">
                Saved automatically so it's one tap next time.
              </p>
            </div>
          )}
          {endMode === "anywhere" && (
            <p className="mt-1 text-[11px] text-later">
              Shortest overall path; you stop wherever the last door is.
            </p>
          )}
        </fieldset>

        {/* 3. How many doors */}
        <fieldset className="mb-4">
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
            How many doors?
          </legend>
          <div className="grid grid-cols-3 gap-1.5">
            {DOOR_OPTIONS.map((n) => (
              <button key={n} onClick={() => setMaxDoors(n)} className={chip(maxDoors === n)}>
                {n === 0 ? "No limit" : `Up to ${n}`}
              </button>
            ))}
          </div>
        </fieldset>

        {/* 4. How far */}
        <fieldset className="mb-5">
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
            How far will you drive, total?
          </legend>
          <div className="grid grid-cols-3 gap-1.5">
            {MILE_OPTIONS.map((n) => (
              <button key={n} onClick={() => setMaxMiles(n)} className={chip(maxMiles === n)}>
                {n === 0 ? "No limit" : `${n} mi`}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-later">
            Doors are picked as a tight pocket, not a ring around you, so the next
            stop is usually the next street over.
          </p>
        </fieldset>

        {err && (
          <p role="alert" className="mb-3 rounded-xl border border-overdue/40 bg-overdue-50 px-3 py-2 text-xs text-overdue">
            {err}
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="min-h-11 flex-1 rounded-xl border border-line px-3 text-sm text-worked hover:bg-paper"
          >
            Cancel
          </button>
          <button
            onClick={build}
            disabled={resolving}
            className="flex min-h-11 flex-[2] items-center justify-center gap-1.5 rounded-xl bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
          >
            {resolving ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <MapPin size={15} aria-hidden />}
            {resolving ? "Finding address…" : "Build route"}
          </button>
        </div>
      </div>
    </div>
  );
}
