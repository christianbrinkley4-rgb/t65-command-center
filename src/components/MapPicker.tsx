"use client";

// Drop a pin instead of typing an address.
//
// Half the places a route starts or ends at don't have an address worth
// typing on a phone: the church parking lot off Battleground, the cul-de-sac
// you're going to park in, "the corner where I left off Tuesday." Typing those
// means guessing at a street number and hoping the geocoder agrees. Dragging a
// pin means saying exactly where, once, and being done.
//
// A dropped pin is also a BETTER route input than a typed address, not a
// worse one: it's already a coordinate, so nothing has to be geocoded, nothing
// can come back "no match", and the Google Maps handoff takes "lat,lng"
// happily. The reverse-geocoded street name is decoration for the chip.
//
// Leaflet with OpenStreetMap tiles: no API key, no billing, no account. The
// alternative was hand-rolling tile math, and pinch-zoom that misbehaves in a
// driveway is not worth the 42KB saved. Loaded on demand so it costs nothing
// until the map is actually opened.

import { useCallback, useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap, Marker as LeafletMarker, LeafletMouseEvent } from "leaflet";
import { X, LocateFixed, LoaderCircle, Check } from "lucide-react";
import { OFFICE } from "@/lib/distance";
import { reverseGeocode } from "@/lib/geocode";
import { coordLabel, savePlace, type SavedPlace } from "@/lib/places";
import type { LatLng } from "@/lib/route";

// Terracotta to match the app, drawn inline so Leaflet never reaches for its
// default marker PNGs — those resolve to broken paths under a bundler and a
// basePath, which is a classic Leaflet-in-Next footgun.
const PIN_SVG = `
<svg width="34" height="46" viewBox="0 0 34 46" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M17 45c0 0-14-17.6-14-27A14 14 0 0 1 31 18c0 9.4-14 27-14 27z"
        fill="#C2410C" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="17" cy="17.5" r="5" fill="#FFFFFF"/>
</svg>`;

export default function MapPicker({
  open,
  title,
  initial,
  onCancel,
  onPick,
}: {
  open: boolean;
  /** "Start from" or "Finish at" — the map is the same, the sentence isn't. */
  title: string;
  /** Where to open the map. Usually current GPS, else the office. */
  initial: LatLng | null;
  onCancel: () => void;
  onPick: (place: SavedPlace) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);

  const [point, setPoint] = useState<LatLng | null>(null);
  const [resolved, setResolved] = useState<{ label: string; address: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const [locating, setLocating] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Moving the pin is the one thing this screen does, so it's the one thing
  // every gesture funnels into: drag it, tap the map, or hit "my location".
  const movePin = useCallback((lat: number, lng: number) => {
    setPoint({ lat, lng });
    setResolved(null);
    markerRef.current?.setLatLng([lat, lng]);
  }, []);

  // Build the map when the sheet opens; tear it down when it closes. Leaflet
  // holds DOM and listeners, and a second map on the same node throws.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const startAt = initial ?? OFFICE;

    (async () => {
      try {
        const L = await import("leaflet");
        if (cancelled || !hostRef.current) return;

        const map = L.map(hostRef.current, {
          center: [startAt.lat, startAt.lng],
          zoom: initial ? 16 : 13,
          zoomControl: false,
          attributionControl: true,
        });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap",
        }).addTo(map);
        L.control.zoom({ position: "bottomright" }).addTo(map);

        const marker = L.marker([startAt.lat, startAt.lng], {
          draggable: true,
          autoPan: true,
          keyboard: true,
          title: "Drag to move",
          icon: L.divIcon({
            html: PIN_SVG,
            className: "t65-pin",
            iconSize: [34, 46],
            iconAnchor: [17, 45],
          }),
        }).addTo(map);

        marker.on("dragend", () => {
          const ll = marker.getLatLng();
          movePin(ll.lat, ll.lng);
        });
        // Tapping is faster than dragging when the pin is off-screen, and on a
        // phone it's the gesture people try first.
        map.on("click", (e: LeafletMouseEvent) => movePin(e.latlng.lat, e.latlng.lng));

        mapRef.current = map;
        markerRef.current = marker;
        setPoint(startAt);
        setReady(true);
        // The sheet animates in, so the map is sized before its box is final.
        setTimeout(() => map.invalidateSize(), 60);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      setReady(false);
      setFailed(false);
      setPoint(null);
      setResolved(null);
    };
    // `initial` is the opening camera position only; changing it mid-session
    // must not rebuild the map under the agent's thumb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, movePin]);

  // Name the pin, quietly. Debounced past the end of a drag so a gesture is
  // one lookup rather than forty, which also keeps us inside Nominatim's
  // one-request-a-second etiquette.
  useEffect(() => {
    if (!open || !point) return;
    const ctrl = new AbortController();
    setLooking(true);
    const t = setTimeout(async () => {
      const hit = await reverseGeocode(point.lat, point.lng, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setResolved(hit);
      setLooking(false);
    }, 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      setLooking(false);
    };
  }, [open, point]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        movePin(lat, lng);
        mapRef.current?.setView([lat, lng], 17);
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  function confirm() {
    if (!point) return;
    const place: SavedPlace = {
      label: resolved?.label || "Dropped pin",
      // No address is a legitimate answer. Downstream falls back to the
      // coordinate, which Google Maps routes to more reliably than a street
      // number the geocoder had to guess at anyway.
      address: resolved?.address || "",
      lat: point.lat,
      lng: point.lng,
    };
    savePlace(place);
    onPick(place);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} — choose a point on the map`}
        className="flex h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-lift sm:h-[80vh] sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
            <p className="mt-0.5 text-xs text-worked">
              Drag the pin, or tap anywhere on the map.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close map"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="relative flex-1">
          <div ref={hostRef} className="absolute inset-0 bg-paper" aria-hidden />

          {!ready && !failed && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex items-center gap-2 rounded-xl bg-white/90 px-3 py-2 text-sm text-worked shadow-card">
                <LoaderCircle size={15} className="animate-spin" aria-hidden />
                Loading the map…
              </span>
            </div>
          )}

          {failed && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <p className="max-w-xs text-center text-sm text-worked">
                The map couldn&apos;t load. It needs a signal the first time. Type the
                address instead, or try again on wifi.
              </p>
            </div>
          )}

          {ready && (
            <button
              onClick={useMyLocation}
              disabled={locating}
              className="absolute right-3 top-3 z-[500] flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-xs font-semibold text-worked shadow-card hover:bg-paper disabled:opacity-60"
            >
              {locating ? (
                <LoaderCircle size={13} className="animate-spin" aria-hidden />
              ) : (
                <LocateFixed size={13} aria-hidden />
              )}
              {locating ? "Finding you…" : "My location"}
            </button>
          )}
        </div>

        {/* What you're about to pick, in words, above the button that picks
            it. A coordinate you can't read is a coordinate you can't check. */}
        <div className="border-t border-line px-4 py-3">
          <p className="text-sm font-semibold text-ink">
            {looking ? "Looking up this spot…" : resolved?.label || "Dropped pin"}
          </p>
          <p className="mt-0.5 text-[11px] text-later tabular-nums">
            {resolved?.address && resolved.address !== resolved.label
              ? resolved.address
              : point
                ? coordLabel(point.lat, point.lng)
                : ""}
          </p>

          <div className="mt-3 flex gap-2">
            <button
              onClick={onCancel}
              className="min-h-11 flex-1 rounded-xl border border-line px-3 text-sm text-worked hover:bg-paper"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={!point}
              className="flex min-h-11 flex-[2] items-center justify-center gap-1.5 rounded-xl bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
            >
              <Check size={15} aria-hidden />
              Use this spot
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
