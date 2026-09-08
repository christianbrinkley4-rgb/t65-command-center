"use client";

// Ask the book a question and get names back.
//
// The ranked list is computed locally and shown whether or not the model
// answers. That ordering is deliberate: the list IS the answer, and the prose
// is commentary on it. If Gemini is down, over capacity, or unconfigured, you
// still get twenty names in the right order with the reason each one is there,
// which is the thing you actually needed. A panel that shows nothing because a
// third party is busy would be worse than no panel.
//
// Every ask is written to assistant_asks with the lead ids it named. Nothing
// reads that table yet, and it is not decoration: it is the only way to answer
// "was this advice any good" later, by joining those ids against what got
// dialed and what came of it. See the migration for the query.

import { useMemo, useState } from "react";
import { Sparkles, LoaderCircle, Phone, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useApp } from "@/lib/context";
import { supabase } from "@/lib/supabaseClient";
import { buildBrief, rankNow, type Pick } from "@/lib/coach";
import { formatPhone, bestPhone } from "@/lib/phone";
import type { Activity } from "@/lib/types";

const SUGGESTIONS = [
  "Who should I dial right now?",
  "Who have I promised to call back and not called?",
  "Is this a good hour to be on the phone?",
  "Who is closest to their enrollment deadline?",
];

export default function CoachPanel({ activity }: { activity: Activity[] }) {
  const { leads, me, worked } = useApp();
  const [question, setQuestion] = useState(SUGGESTIONS[0]);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState<Pick[] | null>(null);

  // Recomputed from live rows on every render, which is the whole mechanism:
  // there is no stored model and nothing to go stale.
  const ranked = useMemo(
    () => rankNow(leads, activity, worked, new Date()),
    [leads, activity, worked]
  );

  const hourNote = useMemo(() => {
    const f = ranked.factor;
    if (f >= 1.15) return { tone: "good", text: `This hour reaches ${f.toFixed(2)}x your daily average. Good time to be dialing.` };
    if (f <= 0.85) return { tone: "bad", text: `This hour reaches ${f.toFixed(2)}x your daily average. Your weakest hours are worth spending on doors or admin.` };
    return { tone: "flat", text: `This hour is about average for reaching people (${f.toFixed(2)}x).` };
  }, [ranked.factor]);

  async function ask() {
    if (asking || !question.trim()) return;
    setAsking(true);
    setAnswer(null);
    setNote(null);
    const picks = ranked.picks.slice(0, 20);
    setShown(picks);

    const brief = buildBrief(question, ranked);
    let text: string | null = null;
    let why: string | null = null;
    try {
      const { data } = await supabase.functions.invoke("coach", { body: { brief } });
      if (data?.ok) text = data.answer;
      else why = data?.reason || "The coach did not answer.";
    } catch (e) {
      why = e instanceof Error ? e.message : "Could not reach the coach.";
    }
    setAnswer(text);
    setNote(why);

    // Logged whether or not the model answered. The value is in the lead ids
    // and the hour, not the prose.
    supabase
      .from("assistant_asks")
      .insert({
        asked_by: me,
        question,
        answer: text,
        local_hour: new Date().getHours(),
        hour_factor: ranked.factor,
        recommended_lead_ids: picks.map((p) => p.lead.id),
        candidate_count: ranked.picks.length,
        source: "coach-panel",
      })
      .then(() => {}, () => {});

    setAsking(false);
  }

  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-brand" />
        <p className="text-sm font-semibold text-ink">Ask the book</p>
      </div>

      <p
        className={
          hourNote.tone === "good"
            ? "mt-2 text-xs text-newlead"
            : hourNote.tone === "bad"
              ? "mt-2 text-xs text-due"
              : "mt-2 text-xs text-worked"
        }
      >
        {hourNote.text} {ranked.picks.length} leads are callable right now.
      </p>

      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask();
        }}
        rows={2}
        className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setQuestion(s)}
            className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-worked hover:bg-paper"
          >
            {s}
          </button>
        ))}
      </div>

      <button
        onClick={() => void ask()}
        disabled={asking || !question.trim()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
      >
        {asking ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {asking ? "Thinking…" : "Ask"}
      </button>

      {answer && (
        <p className="mt-4 whitespace-pre-wrap rounded-xl bg-paper px-4 py-3 text-sm leading-relaxed text-slate-700">
          {answer}
        </p>
      )}
      {note && (
        <p role="status" className="mt-3 rounded-lg bg-due/10 px-2.5 py-2 text-[11px] leading-relaxed text-ink">
          {note} The ranked list below is computed here and is unaffected.
        </p>
      )}

      {shown && shown.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-worked">
            Call these, in this order
          </p>
          <div className="overflow-hidden rounded-xl border border-line">
            {shown.map((p, i) => {
              const phone = bestPhone(p.lead).number;
              return (
                <div
                  key={p.lead.id}
                  className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      <span className="mr-1.5 text-later">{i + 1}</span>
                      {p.lead.name || "Unnamed"}
                    </p>
                    <p className="truncate text-[11px] text-later">{p.why.join(" · ")}</p>
                  </div>
                  {phone && (
                    <a
                      href={`tel:${phone}`}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark"
                    >
                      <Phone size={12} /> {formatPhone(phone)}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
          <Link
            href="/session/"
            className="mt-2 flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            Work these in a Dial Session <ArrowRight size={12} />
          </Link>
        </div>
      )}
    </div>
  );
}
