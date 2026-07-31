"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp } from "@/lib/context";
import { supabase } from "@/lib/supabaseClient";
import { enrollLeads, stepsFor } from "@/lib/sequences";
import type { Sequence, SequenceStep } from "@/lib/types";

const CHANNELS = ["Call", "Text", "Email", "Mail", "Door Knock"];

type EditableStep = {
  step_number: number;
  day_offset: number;
  channel: string;
  instructions: string;
};

function SequenceCard({ seq }: { seq: Sequence }) {
  const { leads, steps, enrollments, reload, me } = useApp();
  const [name, setName] = useState(seq.name);
  const [description, setDescription] = useState(seq.description || "");
  const [isDraft, setIsDraft] = useState(seq.is_draft);
  const [rows, setRows] = useState<EditableStep[]>(
    stepsFor(seq.id, steps).map((s) => ({
      step_number: s.step_number,
      day_offset: s.day_offset,
      channel: s.channel,
      instructions: s.instructions || "",
    }))
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const stats = useMemo(() => {
    const mine = enrollments.filter((e) => e.sequence_id === seq.id);
    return {
      active: mine.filter((e) => e.status === "active").length,
      completed: mine.filter((e) => e.status === "completed").length,
      exited: mine.filter((e) => e.status === "exited").length,
    };
  }, [enrollments, seq.id]);

  // Leads matching the source filter that are not closed and have never been
  // enrolled in this sequence (previously exited leads are not re-enrolled).
  const eligible = useMemo(() => {
    if (!seq.source_filter) return [];
    const everEnrolled = new Set(
      enrollments.filter((e) => e.sequence_id === seq.id).map((e) => e.lead_id)
    );
    return leads.filter(
      (l) =>
        l.source === seq.source_filter &&
        l._bucket !== "Closed" &&
        !everEnrolled.has(l.id) &&
        (!l._enr || l._enr.status !== "active")
    );
  }, [leads, enrollments, seq.id, seq.source_filter]);

  function setRow(i: number, patch: Partial<EditableStep>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((rs) => [
      ...rs,
      {
        step_number: rs.length + 1,
        day_offset: rs.length ? rs[rs.length - 1].day_offset + 3 : 0,
        channel: "Call",
        instructions: "",
      },
    ]);
  }

  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i).map((r, j) => ({ ...r, step_number: j + 1 })));
  }

  async function saveSequence() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const { error: seqErr } = await supabase
        .from("sequences")
        .update({
          name: name.trim() || seq.name,
          description: description.trim() || null,
          is_draft: isDraft,
          updated_at: new Date().toISOString(),
        })
        .eq("id", seq.id);
      if (seqErr) throw seqErr;

      const { error: delErr } = await supabase
        .from("sequence_steps")
        .delete()
        .eq("sequence_id", seq.id);
      if (delErr) throw delErr;
      if (rows.length > 0) {
        const { error: insErr } = await supabase.from("sequence_steps").insert(
          rows.map((r, i) => ({
            sequence_id: seq.id,
            step_number: i + 1,
            day_offset: r.day_offset,
            channel: r.channel,
            instructions: r.instructions.trim() || null,
          }))
        );
        if (insErr) throw insErr;
      }
      await reload();
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function bulkEnroll() {
    if (eligible.length === 0 || rows.length === 0) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const firstStep = stepsFor(seq.id, steps)[0];
      if (!firstStep) throw new Error("Save the steps before enrolling.");
      await enrollLeads(
        eligible.map((l) => l.id),
        seq,
        firstStep,
        me
      );
      await reload();
      setMsg(`Enrolled ${eligible.length} leads.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Enroll failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-transparent px-1 py-0.5 text-base font-semibold text-ink outline-none hover:border-line focus:border-brand"
        />
        {isDraft && (
          <span className="rounded bg-verify px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
            Draft
          </span>
        )}
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} />
          draft
        </label>
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="What this sequence is for, and any rules for using it"
        className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-xs text-slate-600 outline-none focus:border-brand"
      />

      <p className="mt-2 text-xs text-slate-500">
        {seq.source_filter ? `Targets source: ${seq.source_filter} · ` : ""}
        {stats.active} active · {stats.completed} completed · {stats.exited} exited
      </p>

      <div className="mt-3 space-y-1.5">
        <div className="grid grid-cols-[3rem_4rem_7rem_1fr_2rem] items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          <span>Step</span>
          <span>Day</span>
          <span>Channel</span>
          <span>Instructions</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[3rem_4rem_7rem_1fr_2rem] items-center gap-1.5">
            <span className="text-sm text-slate-500">{i + 1}</span>
            <input
              type="number"
              min={0}
              value={r.day_offset}
              onChange={(e) => setRow(i, { day_offset: Math.max(0, Number(e.target.value)) })}
              className="rounded-md border border-line px-2 py-1.5 text-sm"
            />
            <select
              value={r.channel}
              onChange={(e) => setRow(i, { channel: e.target.value })}
              className="rounded-md border border-line px-2 py-1.5 text-sm"
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              value={r.instructions}
              onChange={(e) => setRow(i, { instructions: e.target.value })}
              placeholder="What to do on this touch"
              className="rounded-md border border-line px-2 py-1.5 text-sm"
            />
            <button
              onClick={() => removeRow(i)}
              className="rounded-md p-1 text-slate-300 hover:bg-slate-50 hover:text-overdue"
              title="Remove step"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          onClick={addRow}
          className="flex items-center gap-1 rounded-md border border-dashed border-line px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
        >
          <Plus size={12} /> Add step
        </button>
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        Day = days after enrollment. When a touch is logged late, the gap to the next step is kept
        from the day you actually logged it.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={saveSequence}
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Working…" : "Save sequence"}
        </button>
        {seq.source_filter && (
          <button
            onClick={bulkEnroll}
            disabled={busy || eligible.length === 0}
            title={
              isDraft
                ? "This cadence is still marked draft — you can enroll, but edit the steps to the real cycle first."
                : ""
            }
            className="rounded-lg border border-line px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Enroll {eligible.length} eligible {seq.source_filter} leads
          </button>
        )}
        {msg && <span className="text-xs text-newlead">{msg}</span>}
        {err && <span className="text-xs text-overdue">{err}</span>}
      </div>
      {isDraft && (
        <p className="mt-2 rounded-lg bg-verify-50 px-3 py-2 text-xs text-verify">
          Draft cadence: the steps below are placeholders. Edit them to the real cycle, uncheck
          draft, then enroll. Nothing sends automatically — the app schedules touches into
          Today&apos;s Queue and you make every call, text, and email yourself.
        </p>
      )}
    </div>
  );
}

export default function SequencesPage() {
  const { sequences, leadsLoading, reload } = useApp();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSource, setNewSource] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function createSequence() {
    if (!newName.trim()) return;
    setCreating(true);
    setErr(null);
    try {
      const { error } = await supabase.from("sequences").insert({
        name: newName.trim(),
        source_filter: newSource.trim() || null,
        is_draft: true,
      });
      if (error) throw error;
      setNewName("");
      setNewSource("");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-ink">Nurture Sequences</h1>
        <p className="text-sm text-slate-500">
          {leadsLoading ? "Loading…" : `${sequences.length} sequence${sequences.length === 1 ? "" : "s"}`}
        </p>
      </div>

      <div className="space-y-4">
        {sequences.map((s) => (
          <SequenceCard key={s.id + s.updated_at} seq={s} />
        ))}

        <div className="rounded-xl border border-dashed border-line bg-white p-4">
          <p className="mb-2 text-sm font-medium text-ink">New sequence</p>
          <div className="flex flex-wrap gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. Mailer Follow-Up)"
              className="flex-1 rounded-md border border-line px-3 py-2 text-sm"
            />
            <input
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="Source filter (optional, e.g. SmartAsset)"
              className="flex-1 rounded-md border border-line px-3 py-2 text-sm"
            />
            <button
              onClick={createSequence}
              disabled={creating || !newName.trim()}
              className="rounded-lg border border-line px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Create
            </button>
          </div>
          {err && <p className="mt-2 text-xs text-overdue">{err}</p>}
        </div>
      </div>
    </div>
  );
}
