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
  // Leads worked this session — lives in context (not a page) so switching tabs
  // doesn't resurface the morning's calls into the queue to be re-dialed.
  const [worked, setWorked] = useState<Set<string>>(new Set());
  const markWorked = (id: string) => setWorked((s) => new Set(s).add(id));
  const unmarkWorked = (id: string) =>
    setWorked((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  const clearWorked = () => setWorked(new Set());

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
