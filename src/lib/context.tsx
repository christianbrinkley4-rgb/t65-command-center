"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLeads } from "@/hooks/useLeads";
import type {
  Lead,
  LeadWithBucket,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  LeadAction,
  WhoFilter,
} from "@/lib/types";
import type { Session } from "@supabase/supabase-js";

type Ctx = {
  session: Session | null;
  authLoading: boolean;
  signIn: (email: string, password: string) => Promise<any>;
  signOut: () => Promise<void>;
  leads: LeadWithBucket[];
  sequences: Sequence[];
  steps: SequenceStep[];
  enrollments: SequenceEnrollment[];
  actions: LeadAction[];
  actionsError: string | null;
  leadsLoading: boolean;
  leadsError: string | null;
  lastLoadedAt: Date | null;
  reload: () => Promise<void>;
  updateLead: (id: string, updates: Partial<Lead>) => Promise<void>;
  who: WhoFilter;
  setWho: (w: WhoFilter) => void;
  me: string;
  setMe: (m: string) => void;
  worked: Set<string>;
  markWorked: (id: string) => void;
  unmarkWorked: (id: string) => void;
  clearWorked: () => void;
};

const AppContext = createContext<Ctx | null>(null);

const WORKED_KEY = "t65-worked-today";

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { session, loading: authLoading, signIn, signOut } = useAuth();
  const {
    leads,
    sequences,
    steps,
    enrollments,
    actions,
    actionsError,
    loading: leadsLoading,
    error: leadsError,
    lastLoadedAt,
    reload,
    updateLead,
  } = useLeads(!!session);
  const [who, setWho] = useState<WhoFilter>("Everyone");
  const [me, setMeState] = useState("Christian");
  // Leads worked TODAY. Lives in context (not a page) so switching tabs doesn't
  // resurface the morning's calls, and mirrored to localStorage keyed by date so
  // neither does a browser refresh — which is how you end up redialing someone
  // at 2pm that you already tried at 9am. The key carries the day, so it empties
  // itself overnight without any cleanup.
  //
  // This is the belt to the braces in priority.ts: a disposition writes a dated
  // callback and the queue hides the lead on the data, but a tap-to-dial with no
  // result recorded leaves nothing on the row to hide it by. This remembers it.
  const [worked, setWorked] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKED_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && saved.day === todayKey() && Array.isArray(saved.ids)) {
        setWorked(new Set(saved.ids));
      } else {
        localStorage.removeItem(WORKED_KEY);
      }
    } catch {
      /* a corrupt entry just means we start the day empty */
    }
  }, []);

  const persistWorked = (next: Set<string>) => {
    try {
      localStorage.setItem(WORKED_KEY, JSON.stringify({ day: todayKey(), ids: [...next] }));
    } catch {
      /* out of quota — the in-memory set still holds for this session */
    }
    return next;
  };

  const markWorked = (id: string) => setWorked((s) => persistWorked(new Set(s).add(id)));
  const unmarkWorked = (id: string) =>
    setWorked((s) => {
      const n = new Set(s);
      n.delete(id);
      return persistWorked(n);
    });
  const clearWorked = () => setWorked(persistWorked(new Set()));

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("t65-cc-me") : null;
    if (saved) setMeState(saved);
  }, []);

  const setMe = (m: string) => {
    setMeState(m);
    localStorage.setItem("t65-cc-me", m);
  };

  const value = useMemo(
    () => ({
      session,
      authLoading,
      signIn,
      signOut,
      leads,
      sequences,
      steps,
      enrollments,
      actions,
      actionsError,
      leadsLoading,
      leadsError,
      lastLoadedAt,
      reload,
      updateLead,
      who,
      setWho,
      me,
      setMe,
      worked,
      markWorked,
      unmarkWorked,
      clearWorked,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, authLoading, signIn, signOut, leads, sequences, steps, enrollments, actions, actionsError, leadsLoading, leadsError, lastLoadedAt, reload, updateLead, who, me, worked]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
