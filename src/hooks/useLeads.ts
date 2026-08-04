"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { withBuckets } from "@/lib/buckets";
import { canonicalPhone } from "@/lib/phone";
import { activeEnrollmentMap, fetchSequenceData } from "@/lib/sequences";
import { actionMap, fetchPendingActions } from "@/lib/actions";
import { cacheLeads, getCachedLeads } from "@/lib/offline";
import { askedNotToBeCalled, isMerged } from "@/lib/types";
import type { Lead, LeadAction, LeadWithBucket, Sequence, SequenceEnrollment, SequenceStep } from "@/lib/types";

const PAGE_SIZE = 1000;

async function fetchAllLeads(): Promise<Lead[]> {
  let all: Lead[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data) break;
    all = all.concat(data as Lead[]);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export function useLeads(enabled: boolean) {
  const [leads, setLeads] = useState<LeadWithBucket[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [steps, setSteps] = useState<SequenceStep[]>([]);
  const [enrollments, setEnrollments] = useState<SequenceEnrollment[]>([]);
  const [actions, setActions] = useState<LeadAction[]>([]);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [all, seqData, actionData] = await Promise.all([
        fetchAllLeads(),
        fetchSequenceData(),
        fetchPendingActions(),
      ]);
      setSequences(seqData.sequences);
      setSteps(seqData.steps);
      setEnrollments(seqData.enrollments);
      setActions(actionData.actions);
      setActionsError(actionData.error);

      // Count phones (canonicalized) for the duplicate flag, and collect every
      // phone that belongs to a Do-Not-Call record so a twin lead sharing that
      // number is suppressed too (DNC is per-person, not per-row).
      // A merged row is a tombstone, not a lead. It stops being counted, listed
      // or searched here, at the one place every screen loads from. DNC still
      // reads the full set: a suppression must survive the merge either way.
      const live = all.filter((l) => !isMerged(l));
      const phoneCounts = new Map<string, number>();
      const dncPhones = new Set<string>();
      for (const l of all) {
        const p = canonicalPhone(l.phone);
        if (p && !isMerged(l)) phoneCounts.set(p, (phoneCounts.get(p) || 0) + 1);
        // Only a recorded request suppresses the household's number. A bulk
        // scrub on one row should not silently take the spouse out of the book
        // too — that's how one list import removed a quarter of the leads.
        if (askedNotToBeCalled(l)) {
          if (p) dncPhones.add(p);
          const p2 = canonicalPhone(l.phone2);
          if (p2) dncPhones.add(p2);
        }
      }
      const bucketed = withBuckets(
        live,
        activeEnrollmentMap(seqData.enrollments),
        actionMap(actionData.actions)
      ).map((l) => {
        const p = canonicalPhone(l.phone);
        const p2 = canonicalPhone(l.phone2);
        return {
          ...l,
          _dupe: !!p && (phoneCounts.get(p) || 0) > 1,
          _dncSuppressed: (!!p && dncPhones.has(p)) || (!!p2 && dncPhones.has(p2)),
        };
      });
      setLeads(bucketed);
      setLastLoadedAt(new Date());
      // Keep a copy so a dead zone shows the book instead of nothing.
      cacheLeads(live);
    } catch (e) {
      // No signal (or the API is down): fall back to the last good copy so the
      // field app still works. Surfaced as a dated notice, never as fresh data.
      const cached = getCachedLeads();
      if (cached) {
        setLeads(
          withBuckets(cached.leads, new Map(), new Map()).map((l) => ({
            ...l,
            _dupe: false,
            _dncSuppressed: false,
          }))
        );
        setLastLoadedAt(cached.at);
        setError(
          `Offline — showing the book as of ${cached.at ? cached.at.toLocaleString() : "your last load"}. Results you record are saved on this phone.`
        );
      } else {
        setError(e instanceof Error ? e.message : "Failed to load leads");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  // Live sync: when either agent changes a lead or a scheduled action, pull a
  // fresh copy (debounced) so the two of them never work stale data or the same
  // lead. Safe no-op if realtime replication isn't enabled on the project.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 1500);
    };
    const channel = supabase
      .channel("t65-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "lead_actions" }, bump)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [enabled]);

  const updateLead = useCallback(async (id: string, updates: Partial<Lead>) => {
    const { error: err } = await supabase.from("leads").update(updates).eq("id", id);
    if (err) throw err;
  }, []);

  return {
    leads,
    sequences,
    steps,
    enrollments,
    actions,
    actionsError,
    loading,
    error,
    lastLoadedAt,
    reload,
    updateLead,
  };
}
