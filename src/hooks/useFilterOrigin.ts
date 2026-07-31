"use client";

// Where "within 20 miles" is measured from.
//
// The office is a constant and always available, so that's the default and it
// never makes the user wait. "Where I am" needs the browser to hand over a
// position, which can take a few seconds or be refused outright, so it is only
// asked for when actually chosen — a page that demands location on load to
// power a filter nobody turned on is how permission prompts get denied
// permanently.
//
// While a fix is pending the origin falls back to the office rather than to
// null. Null would switch the distance filter off silently and quietly widen
// the list the user just narrowed.

import { useEffect, useState } from "react";
import { OFFICE } from "@/lib/distance";
import type { LatLng } from "@/lib/route";
import type { LeadFilterState } from "@/lib/leadFilter";

export function useFilterOrigin(filter: LeadFilterState): {
  origin: LatLng | null;
  usingFallback: boolean;
} {
  const wantsMe = filter.maxMiles > 0 && filter.origin === "me";
  const [me, setMe] = useState<LatLng | null>(null);

  useEffect(() => {
    if (!wantsMe || me || typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (!cancelled) setMe({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
    return () => {
      cancelled = true;
    };
  }, [wantsMe, me]);

  if (!filter.maxMiles) return { origin: null, usingFallback: false };
  if (wantsMe) return { origin: me || OFFICE, usingFallback: !me };
  return { origin: OFFICE, usingFallback: false };
}
