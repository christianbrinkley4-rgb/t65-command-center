"use client";

// The Duplicates pile, worked one household at a time.
//
// A flat list of duplicate rows is useless — you can't merge what you can't see
// side by side. So this groups by number and shows the two (or three) records
// together with the facts that decide which one survives: how many times each
// has been dialed, when it was last worked, what it knows that the other
// doesn't. Then it tells you exactly what the merge will do before you do it,
// because this is the one action in the app that isn't one click of undo.

import { useMemo, useState } from "react";
import { Merge, Phone, Users, ChevronDown, ChevronRight } from "lucide-react";
import { useApp } from "@/lib/context";
import { duplicateGroups, mergeLeads, previewMerge } from "@/lib/merge";
import { canonicalPhone } from "@/lib/phone";
import { listLabel } from "@/lib/categories";
import T65Badge from "@/components/T65Badge";
import type { LeadWithBucket } from "@/lib/types";

function factLine(l: LeadWithBucket): string {
  const bits: string[] = [];
  bits.push(listLabel(l.source));
  if (l.dials_count) bits.push(`${l.dials_count} dial${l.dials_count === 1 ? "" : "s"}`);
  if (l.knock_count) bits.push(`${l.knock_count} knock${l.knock_count === 1 ? "" : "s"}`);
  if (l.last_contact_date) bits.push(`last worked ${l.last_contact_date}`);
  if (l.oscr_lead_id) bits.push("linked to OSCR");
  if (l.appointment_datetime) bits.push("has an appointment");
  if (l.do_not_call) bits.push("DNC");
  return bits.join(" · ");
}

function Group({
  group,
  onOpen,
  onMerged,
}: {
  group: LeadWithBucket[];
  onOpen: (lead: LeadWithBucket) => void;
  onMerged: () => void;
}) {
  const { me } = useApp();
  const [survivorId, setSurvivorId] = useState(group[0].id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const survivor = group.find((l) => l.id === survivorId) || group[0];
  const losers = group.filter((l) => l.id !== survivor.id);

  const preview = useMemo(
    () => losers.map((loser) => ({ loser, ...previewMerge(survivor, loser) })),
    [survivor, losers]
  );

  async function run() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      // One at a time and in order. mergeLeads re-reads the survivor before
      // each pass, so folding three rows folds the second into the row the
      // first pass already updated rather than into a stale copy.
      for (const loser of losers) {
        await mergeLeads(survivor, loser, me);
      }
      onMerged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 bg-paper/50 px-3 py-2">
        <Phone size={13} className="text-worked" aria-hidden />
        <span className="text-sm font-semibold text-ink tabular-nums">{survivor.phone}</span>
        <span className="text-xs text-later">
          {group.length} records for what looks like one person
        </span>
        <button
          onClick={run}
          disabled={busy}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
        >
          <Merge size={12} aria-hidden />
          {busy ? "Merging…" : losers.length === 1 ? "Merge these two" : `Merge all ${group.length}`}
        </button>
      </div>

      <div className="divide-y divide-line">
        {group.map((l) => {
          const isSurvivor = l.id === survivor.id;
          return (
            <div
              key={l.id}
              className={isSurvivor ? "flex items-start gap-3 bg-brand-light/25 px-3 py-2.5" : "flex items-start gap-3 px-3 py-2.5"}
            >
              <label className="mt-0.5 flex shrink-0 items-center" title="Keep this record">
                <input
                  type="radio"
                  name={`survivor-${survivor.phone}`}
                  checked={isSurvivor}
                  onChange={() => setSurvivorId(l.id)}
                  aria-label={`Keep the record for ${l.name || "this lead"} from ${listLabel(l.source)}`}
                />
              </label>
              <button onClick={() => onOpen(l)} className="min-w-0 flex-1 text-left">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                  <span className="truncate">{l.name || "Unnamed"}</span>
                  <T65Badge birthday={l.birthday} />
                  {isSurvivor && (
                    <span className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                      keeping
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-later">{factLine(l)}</p>
                {l.address && <p className="truncate text-xs text-worked">{l.address}</p>}
              </button>
            </div>
          );
        })}
      </div>

      <div className="px-3 pb-2.5">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[11px] font-medium text-worked hover:text-ink"
        >
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          What the merge will do
        </button>
        {open && (
          <div className="mt-1.5 space-y-2 rounded-lg bg-paper/60 px-3 py-2 text-[11px] leading-relaxed text-worked">
            {preview.map(({ loser, kept, conflicts }) => (
              <div key={loser.id}>
                <p className="font-semibold text-ink">
                  Folding in the {listLabel(loser.source)} row
                </p>
                <ul className="mt-0.5 list-disc pl-4">
                  <li>Dials and knocks add up; the later contact date wins.</li>
                  <li>Its calls, notes and pending tasks move onto the record you&apos;re keeping.</li>
                  {kept.map((k) => (
                    <li key={k}>Takes its {k}.</li>
                  ))}
                  {conflicts.map((c) => (
                    <li key={c} className="text-due">
                      {c} — written into the notes, not thrown away.
                    </li>
                  ))}
                  <li>The folded row stays in the database as a tombstone. Nothing is deleted.</li>
                </ul>
              </div>
            ))}
          </div>
        )}
        {err && <p className="mt-1.5 text-[11px] text-overdue">{err}</p>}
      </div>
    </div>
  );
}

export default function DuplicateGroups({
  leads,
  onOpen,
  onMerged,
}: {
  leads: LeadWithBucket[];
  onOpen: (lead: LeadWithBucket) => void;
  onMerged: () => void;
}) {
  const { duplicates, households } = useMemo(() => duplicateGroups(leads), [leads]);

  if (duplicates.length === 0 && households.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-white p-10 text-center">
        <p className="text-sm text-later">No two rows share a phone number. Nothing to look at.</p>
      </div>
    );
  }

  const dupeRows = duplicates.reduce((n, g) => n + g.length, 0);

  return (
    <div className="space-y-4">
      {duplicates.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
          <p className="border-b border-line bg-paper/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-later">
            {duplicates.length} number{duplicates.length === 1 ? "" : "s"} · {dupeRows} rows · pick
            the record to keep
          </p>
          {duplicates.map((g) => (
            <Group key={canonicalPhone(g[0].phone)} group={g} onOpen={onOpen} onMerged={onMerged} />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-line bg-white p-8 text-center">
          <p className="text-sm text-later">
            Nothing here is safely mergeable. Every shared number below belongs to two different
            people.
          </p>
        </div>
      )}

      {/* Not a to-do list. This is the answer to "why does that lead carry a
          dupe chip if there's nothing to merge" — and it's worth knowing on its
          own terms, because these are one household with one phone, and calling
          it twice in a day is the same mistake as working a duplicate. */}
      {households.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
          <div className="border-b border-line bg-paper/60 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-later">
              {households.length} shared number{households.length === 1 ? "" : "s"} · two people, not
              a duplicate
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-worked">
              Mostly married couples on one landline: two names, two birthdays, two separate
              enrollment windows, so there is deliberately no merge button here. A few are near-miss
              spellings that are too close to call automatically — if two of these really are one
              person, correct the name on one of them and they&apos;ll move up into the mergeable
              list. What the section is worth on its own: one call reaches both, and dialing the
              number twice in a day reaches the same kitchen.
            </p>
          </div>
          {households.map((g) => (
            <div key={canonicalPhone(g[0].phone)} className="border-b border-line px-3 py-2.5 last:border-b-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink tabular-nums">
                <Users size={12} className="text-worked" aria-hidden />
                {g[0].phone}
                <span className="font-normal text-later">
                  {g[0].address ? `· ${g[0].address}` : ""}
                </span>
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {g.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => onOpen(l)}
                    className="flex items-center gap-1.5 text-xs text-worked hover:text-ink"
                  >
                    <span className="font-medium">{l.name || "Unnamed"}</span>
                    <T65Badge birthday={l.birthday} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
