"use client";

import { useEffect, useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { AppProvider, useApp } from "@/lib/context";
import LoginScreen from "@/components/LoginScreen";
import Nav from "@/components/Nav";
import CommandPalette from "@/components/CommandPalette";
import { flushQueue, onQueueChange, queueLength, startQueueAutoFlush } from "@/lib/offline";

/**
 * Permanent connection status. In the field the agent needs to know at a glance
 * that a knock was recorded even when the save hasn't reached the server yet —
 * silence would read as "it saved", which is the one thing we can't allow.
 */
function ConnectionBar() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [flushing, setFlushing] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    setPending(queueLength());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const unsubQueue = onQueueChange(() => setPending(queueLength()));
    const stopAuto = startQueueAutoFlush();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      unsubQueue();
      stopAuto();
    };
  }, []);

  if (online && pending === 0) return null;

  return (
    <div
      role="status"
      className={
        online
          ? "sticky top-14 z-30 flex items-center justify-between gap-2 bg-week px-4 py-2 text-xs font-medium text-white"
          : "sticky top-14 z-30 flex items-center justify-between gap-2 bg-overdue px-4 py-2 text-xs font-medium text-white"
      }
    >
      <span className="flex items-center gap-1.5">
        <CloudOff size={13} aria-hidden />
        {online
          ? `${pending} result${pending === 1 ? "" : "s"} still saving`
          : pending > 0
            ? `Offline — ${pending} result${pending === 1 ? "" : "s"} saved on this phone`
            : "Offline — results will be saved on this phone"}
      </span>
      {online && pending > 0 && (
        <button
          onClick={async () => {
            setFlushing(true);
            await flushQueue();
            setPending(queueLength());
            setFlushing(false);
          }}
          disabled={flushing}
          className="flex items-center gap-1 rounded border border-white/40 px-2 py-0.5 disabled:opacity-60"
        >
          <RefreshCw size={11} aria-hidden className={flushing ? "animate-spin" : ""} /> Send now
        </button>
      )}
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { session, authLoading } = useApp();

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">
        Loading…
      </div>
    );
  }

  if (!session) return <LoginScreen />;

  return (
    <div className="min-h-screen">
      <Nav />
      <ConnectionBar />
      <main className="mx-auto max-w-6xl animate-fade-in px-4 py-7">{children}</main>
      {/* Lives here rather than on a page so ⌘K reaches the book from
          anywhere — including mid-dial, which is the only time it matters. */}
      <CommandPalette />
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  // Register the field service worker so the app opens without signal.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
    navigator.serviceWorker.register(`${base}/sw.js`, { scope: `${base}/` }).catch(() => {
      // Not fatal — the app just loses offline boot.
    });
  }, []);

  return (
    <AppProvider>
      <Gate>{children}</Gate>
    </AppProvider>
  );
}
