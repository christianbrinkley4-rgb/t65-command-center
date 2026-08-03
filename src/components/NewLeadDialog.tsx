"use client";

// Typing in one person.
//
// Everything else that adds leads is bulk: a CSV through the Import tab, a
// pasted block through the Assistant. Neither is the right shape for the thing
// that actually happens most often — someone at church gives Christian a name
// and a number, or a neighbor asks Will to call her sister. The workaround was
// to paste two lines into the Assistant's AI parser and hope, which is a lot of
// machinery for nine fields you already know.
//
// The duplicate check is the point. A hand-typed lead is the likeliest way to
// end up with two rows for one person, so the number is checked against the
// live book as you type, and if it matches an existing lead this offers to open
// THAT lead instead of making a second one.

import { useMemo, useState } from "react";
import { UserRoundPlus, X } from "lucide-react";
import { useApp } from "@/lib/context";
import { supabase } from "@/lib/supabaseClient";
import { canonicalPhone } from "@/lib/phone";
import { logActivity } from "@/lib/sequences";
import LeadIdentityFields, {
  emptyIdentity,
  identityPatch,
  type LeadIdentity,
} from "@/components/LeadIdentityFields";
import type { LeadWithBucket } from "@/lib/types";

export default function NewLeadDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Hands back the existing lead when the number is already in the book. */
  onCreated: (lead: LeadWithBucket | null) => void;
}) {
  const { leads, me, reload } = useApp();
  const [identity, setIdentity] = useState<LeadIdentity>(emptyIdentity);
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const takenPhones = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) {
      const p = canonicalPhone(l.phone);
      if (p) set.add(p);
      const p2 = canonicalPhone(l.phone2);
      if (p2) set.add(p2);
    }
    return set;
  }, [leads]);

  const digits = canonicalPhone(identity.phone);
  const existing =
    digits.length === 10
      ? leads.find(
          (l) => canonicalPhone(l.phone) === digits || canonicalPhone(l.phone2) === digits
        ) || null
      : null;

  const canSave = identity.name.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    try {
      const patch = identityPatch(identity);
      const { data, error } = await supabase
        .from("leads")
        .insert({
          ...patch,
          state: "NC",
          source: source.trim() || "Added by hand",
          assigned_to: "Both",
          status: "New",
          stage_bucket: "New Prospecting",
          raw_notes: note.trim() ? `[${new Date().toISOString().slice(0, 10)} added · ${me}] ${note.trim()}` : null,
        })
        .select()
        .single();
      if (error) throw error;
      if (data?.id) {
        await logActivity(data.id, "Update", "Added by hand", note.trim() || null, me).catch(() => {});
      }
      await reload();
      onCreated(null);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save this lead");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a lead"
        className="my-4 w-full max-w-xl rounded-2xl border border-line bg-white p-6 shadow-lift"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">
              <UserRoundPlus size={18} aria-hidden /> Add a lead
            </h2>
            <p className="mt-0.5 text-sm text-worked">
              One person, typed in. Goes into the queue as never-dialed.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <X size={18} aria-hidden />
          </button>
        </div>

        <LeadIdentityFields value={identity} onChange={setIdentity} takenPhones={takenPhones} />

        {existing && (
          <div className="mt-3 rounded-xl border border-due/40 bg-due-50 px-3 py-2.5">
            <p className="text-xs font-semibold text-due">
              {existing.name || "A lead"} already has this number.
            </p>
            <p className="mt-0.5 text-[11px] text-due/90">
              {existing.status || "New"}
              {existing.last_contact_date ? ` · last worked ${existing.last_contact_date}` : ""}
              {existing.do_not_call ? " · on the Do-Not-Call list" : ""}
            </p>
            <button
              onClick={() => {
                onCreated(existing);
                onClose();
              }}
              className="mt-2 rounded-lg bg-due px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Open that lead instead
            </button>
          </div>
        )}

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
              Where they came from
            </label>
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Referral — Kathy Webb"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
              First note
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Met at church, wife handles the insurance"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
          </div>
        </div>

        {err && <p className="mt-3 text-sm text-overdue">{err}</p>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm text-worked hover:bg-paper">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add lead"}
          </button>
        </div>
        {!identity.name.trim() && (
          <p className="mt-2 text-right text-[11px] text-later">A name is the one thing required.</p>
        )}
      </div>
    </div>
  );
}
