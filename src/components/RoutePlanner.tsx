"use client";

// The "before you walk out the door" dialog: where does the route start and
// end, how many doors do you want, and how far are you willing to drive.
// Everything the optimizer needs, asked once, in the order you'd actually
// decide it.

import { useEffect, useRef, useState } from "react";
import { X, MapPin, LoaderCircle, Star, Bookmark, Trash2, Map as MapIcon } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import type { LatLng, RoutePlan } from "@/lib/route";
import { remainingCount, savedAgo, type SavedRoute } from "@/lib/savedRoutes";
import { coordLabel, loadPlaces, savePlace, type SavedPlace } from "@/lib/places";
import MapPicker from "./MapPicker";

// The plan type lives in lib/route now, so saved-route storage can hold one
// without importing a component. Re-exported because this dialog is still where
// everyone expects to find it.
export type { RoutePlan };
export { loadPlaces, type SavedPlace };

const DOOR_OPTIONS = [5, 10, 15, 20, 30, 0];
const MILE_OPTIONS = [3, 5, 10, 20, 0];

type StartMode = "here" | "address";
type EndMode = "anywhere" | "start" | "address";
/** Which end of the route the map is open for, or closed. */
type MapTarget = "start" | "end" | null;

export default function RoutePlanner({
  open,
  start,
  doorsAvailable,
  saved = [],
  onOpenSaved,
  onDeleteSaved,
  onCancel,
  onBuild,
}: {
  open: boolean;
  start: LatLng | null;
  doorsAvailable: number;
  saved?: SavedRoute[];
  onOpenSaved?: (r: SavedRoute) => void;
  onDeleteSaved?: (id: string) => void;
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
  // A place that already carries its coordinates — dropped on the map, or
  // picked off the saved list. Holding it means Build does no lookup at all,
  // and "no match" stops being a thing that can happen on a sidewalk.
  const [startPin, setStartPin] = useState<SavedPlace | null>(null);
  const [endPin, setEndPin] = useState<SavedPlace | null>(null);
  const [mapFor, setMapFor] = useState<MapTarget>(null);
  // Deleting a route takes two taps. One tap is too easy on a phone held in the
  // same hand as a clipboard, and the route it throws away can't be rebuilt.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setPlaces(loadPlaces());
      setErr(null);
      setResolving(false);
      setConfirmDelete(null);
      setMapFor(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The map sits on top and owns Escape while it's up.
      if (e.key === "Escape" && !mapFor) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, mapFor]);

  if (!open) return null;

  /** Attach an already-located place to one end of the route. */
  function applyPlace(target: Exclude<MapTarget, null>, p: SavedPlace) {
    const shown = p.address || p.label;
    if (target === "start") {
      setStartPin(p);
      setStartAddress(shown);
      setStartMode("address");
    } else {
      setEndPin(p);
      setAddress(shown);
      setEndMode("address");
    }
    setPlaces(loadPlaces());
    setErr(null);
  }

  /**
   * Turn a typed address into a point, reusing a saved place when we already
   * have it so a known office/home costs no network round trip. Throws with a
   * message meant to be shown to someone standing on a sidewalk.
   */
  async function resolveAddress(raw: string, what: "start from" | "finish at"): Promise<SavedPlace> {
    const q = raw.trim();
    if (!q) throw new Error(`Type an address to ${what}, drop a pin on the map, or pick a saved place.`);
    const hit = places.find((p) => p.address.toLowerCase() === q.toLowerCase());
    if (hit) return hit;
    const { data, error } = await supabase.functions.invoke("geocode", { body: { oneline: q } });
    if (error) throw new Error("Address lookup failed. Check your signal and try again.");
    if (!data?.point) {
      throw new Error(
        "Couldn't find that address. Add the city, try a nearby cross street, or drop a pin on the map instead."
      );
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
        const p = startPin ?? (await resolveAddress(startAddress, "start from"));
        startPoint = { lat: p.lat, lng: p.lng };
        startLabel = p.label;
      }

      let endPoint: LatLng | null = null;
      let endLabel: string | null = null;
      let endAddress: string | null = null;
      if (endMode === "address") {
        const p = endPin ?? (await resolveAddress(address, "finish at"));
        endPoint = { lat: p.lat, lng: p.lng };
        endLabel = p.label;
        // A pin with no street address is not a failure: route.ts falls back to
        // "lat,lng" for the Maps destination, which is exact.
        endAddress = p.address || null;
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

  /** Address box + "Map" button + saved-place chips. Same shape at both ends. */
  function placeField(target: Exclude<MapTarget, null>) {
    const isStart = target === "start";
    const value = isStart ? startAddress : address;
    const pin = isStart ? startPin : endPin;
    return (
      <div className="mt-2">
        <div className="flex gap-1.5">
          <input
            value={value}
            onChange={(e) => {
              // Typing means they've abandoned the pin; the text is the truth
              // again and has to be looked up on Build.
              if (isStart) {
                setStartAddress(e.target.value);
                setStartPin(null);
              } else {
                setAddress(e.target.value);
                setEndPin(null);
              }
            }}
            aria-label={isStart ? "Address to start from" : "Address to finish at"}
            placeholder={isStart ? "Office, first appointment, home…" : "Office, next appointment, home…"}
            className="min-w-0 flex-1 rounded-xl border border-line px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
          <button
            onClick={() => setMapFor(target)}
            aria-label={isStart ? "Pick the start on a map" : "Pick the finish on a map"}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-worked hover:bg-paper"
          >
            <MapIcon size={15} aria-hidden />
            Map
          </button>
        </div>

        {pin ? (
          <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-later">
            <MapPin size={11} className="text-brand" aria-hidden />
            <span className="font-semibold text-worked">{pin.label}</span>
            <span className="tabular-nums">· {coordLabel(pin.lat, pin.lng)}</span>
            <button
              onClick={() => setMapFor(target)}
              className="font-semibold text-brand underline underline-offset-2"
            >
              Move it
            </button>
          </p>
        ) : (
          places.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {places.map((p) => (
                <button
                  key={`${p.address}|${p.lat},${p.lng}`}
                  onClick={() => applyPlace(target, p)}
                  className="flex items-center gap-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-worked hover:bg-white"
                >
                  <Star size={11} aria-hidden /> {p.label}
                </button>
              ))}
            </div>
          )
        )}

        {!pin && (
          <p className="mt-1 text-[11px] text-later">
            {isStart
              ? "Plan tomorrow's route from the couch, or start from your next appointment."
              : "Saved automatically so it's one tap next time."}
          </p>
        )}
      </div>
    );
  }

  return (
    <>
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

        {/* Routes you kept. Above the form on purpose: opening Thursday's
            neighborhood again is one tap, not a rebuild that returns a
            different set of doors in a different order. */}
        {saved.length > 0 && onOpenSaved && (
          <div className="mb-4">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-later">
              Saved routes
            </p>
            <div className="space-y-1.5">
              {saved.map((r) => {
                const left = remainingCount(r);
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2"
                  >
                    <button
                      onClick={() => onOpenSaved(r)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                        <Bookmark size={13} className="shrink-0 text-brand" aria-hidden />
                        {r.name}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-worked tabular-nums">
                        {r.stops.length} door{r.stops.length === 1 ? "" : "s"} ·{" "}
                        {left === 0 ? "all worked" : `${left} left`} · updated{" "}
                        {savedAgo(r.savedAt)}
                      </span>
                    </button>
                    {onDeleteSaved &&
                      (confirmDelete === r.id ? (
                        <button
                          onClick={() => {
                            onDeleteSaved(r.id);
                            setConfirmDelete(null);
                          }}
                          className="shrink-0 rounded-lg border border-overdue/40 bg-overdue-50 px-2.5 py-1.5 text-[11px] font-semibold text-overdue"
                        >
                          Delete
                        </button>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(r.id)}
                          aria-label={`Delete saved route ${r.name}`}
                          className="shrink-0 rounded-lg border border-line bg-white p-2 text-later hover:text-overdue"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-later">
              A saved route reopens with today&apos;s notes and outcomes, in the order you
              planned it.
            </p>
          </div>
        )}

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
          {startMode === "address" && placeField("start")}
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
              A location
            </button>
          </div>
          {endMode === "address" && placeField("end")}
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

      {/* Sibling of the backdrop, not a child of it: a tap on the map must not
          bubble into the planner's click-outside-to-close. */}
      <MapPicker
        open={mapFor !== null}
        title={mapFor === "start" ? "Start from" : "Finish at"}
        // Open on the pin already chosen for this end, else wherever the phone
        // is, else the office. Never a blank map of the whole state.
        initial={
          (mapFor === "start" ? startPin : mapFor === "end" ? endPin : null) ?? start ?? null
        }
        onCancel={() => setMapFor(null)}
        onPick={(p) => {
          if (mapFor) applyPlace(mapFor, p);
          setMapFor(null);
        }}
      />
    </>
  );
}
