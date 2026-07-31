// Field survival kit. Door knocking happens in driveways in rural Guilford and
// Randolph, where signal drops to nothing. Two jobs:
//
//   1. The book still opens. Every successful lead load is cached, so a dead
//      zone shows yesterday's data instead of an empty screen.
//   2. No knock is ever lost. A write that fails goes into a durable queue and
//      replays when signal returns. The agent sees the outcome recorded either
//      way, because asking someone to remember which doors didn't save is not
//      a real option.
//
// localStorage (not IndexedDB) on purpose: the payload is a few MB at most,
// the API is synchronous so a queued write can't be lost to a backgrounded
// tab mid-transaction, and it survives a phone reboot.

import { supabase } from "./supabaseClient";
import type { Lead } from "./types";

const LEADS_KEY = "t65-cached-leads";
const LEADS_AT_KEY = "t65-cached-leads-at";
const QUEUE_KEY = "t65-write-queue";

export type QueuedWrite = {
  id: string;
  table: "leads" | "activity_log" | "lead_actions";
  op: "update" | "insert";
  match?: { id: string };
  payload: Record<string, unknown>;
  /** For the UI: what the agent actually did, e.g. "Not home — 1729 Neelley Rd" */
  label: string;
  at: string;
  tries: number;
};

// ---------------------------------------------------------------- lead cache

export function cacheLeads(leads: Lead[]) {
  try {
    localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
    localStorage.setItem(LEADS_AT_KEY, new Date().toISOString());
  } catch {
    // Quota exceeded on a big book — drop the cache rather than half-write it.
    try {
      localStorage.removeItem(LEADS_KEY);
      localStorage.removeItem(LEADS_AT_KEY);
    } catch {
      /* nothing else to do */
    }
  }
}

export function getCachedLeads(): { leads: Lead[]; at: Date | null } | null {
  try {
    const raw = localStorage.getItem(LEADS_KEY);
    if (!raw) return null;
    const leads = JSON.parse(raw);
    if (!Array.isArray(leads) || leads.length === 0) return null;
    const atRaw = localStorage.getItem(LEADS_AT_KEY);
    return { leads, at: atRaw ? new Date(atRaw) : null };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- write queue

export function readQueue(): QueuedWrite[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedWrite[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* if we can't persist we still keep going in-memory this session */
  }
}

export function enqueue(w: Omit<QueuedWrite, "id" | "at" | "tries">): QueuedWrite {
  const item: QueuedWrite = {
    ...w,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    tries: 0,
  };
  writeQueue([...readQueue(), item]);
  notify();
  return item;
}

export function queueLength(): number {
  return readQueue().length;
}

const listeners = new Set<() => void>();
export function onQueueChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a bad listener must not break the flush */
    }
  });
}

async function runWrite(w: QueuedWrite): Promise<void> {
  if (w.table === "leads" && w.op === "update" && w.match?.id) {
    const { error } = await supabase.from("leads").update(w.payload).eq("id", w.match.id);
    if (error) throw error;
    return;
  }
  if (w.op === "insert") {
    const { error } = await supabase.from(w.table).insert(w.payload);
    if (error) throw error;
    return;
  }
  throw new Error(`Unsupported queued write: ${w.table}/${w.op}`);
}

let flushing = false;

/**
 * Replay everything queued, oldest first. Stops at the first failure so writes
 * stay in order (a knock's lead update must land before its activity row).
 * Returns how many made it.
 */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  if (flushing) return { sent: 0, remaining: queueLength() };
  flushing = true;
  let sent = 0;
  try {
    let q = readQueue();
    while (q.length) {
      const next = q[0];
      try {
        await runWrite(next);
        q = q.slice(1);
        writeQueue(q);
        sent += 1;
        notify();
      } catch {
        // Still offline, or the row is gone. Count the attempt and stop; a
        // write that has failed many times is dropped so one poisoned item
        // can't block every later knock forever.
        next.tries += 1;
        if (next.tries >= 8) {
          q = q.slice(1);
          writeQueue(q);
          notify();
          continue;
        }
        writeQueue(q);
        break;
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, remaining: queueLength() };
}

/**
 * Try a write now; if it fails for any reason, queue it and report that it was
 * deferred rather than lost. Callers update the UI optimistically either way.
 */
export async function writeOrQueue(
  w: Omit<QueuedWrite, "id" | "at" | "tries">
): Promise<"sent" | "queued"> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    enqueue(w);
    return "queued";
  }
  try {
    await runWrite({ ...w, id: "direct", at: new Date().toISOString(), tries: 0 });
    return "sent";
  } catch {
    enqueue(w);
    return "queued";
  }
}

/** Flush whenever the network comes back, and once on load. */
export function startQueueAutoFlush(): () => void {
  const go = () => {
    void flushQueue();
  };
  window.addEventListener("online", go);
  const timer = window.setInterval(() => {
    if (navigator.onLine && queueLength() > 0) go();
  }, 20000);
  go();
  return () => {
    window.removeEventListener("online", go);
    window.clearInterval(timer);
  };
}
