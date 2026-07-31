"use client";

import { useEffect, useState } from "react";
import { Copy, Check, Plus, Trash2, Pencil } from "lucide-react";
import { deleteTemplate, fetchTemplates, saveTemplate } from "@/lib/templates";
import type { Template } from "@/lib/types";

const CHANNELS = ["Call", "Voicemail", "Text", "Email", "Other"];
const BLANK = { name: "", channel: "Call", category: "", body: "" };

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<(Partial<Template> & { id?: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setTemplates(await fetchTemplates());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  function copy(t: Template) {
    navigator.clipboard.writeText(t.body).then(() => {
      setCopied(t.id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  async function save() {
    if (!editing?.name?.trim() || !editing?.body?.trim()) return;
    setBusy(true);
    try {
      await saveTemplate(editing);
      setEditing(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this template?")) return;
    await deleteTemplate(id);
    await load();
  }

  const categories = Array.from(new Set(templates.map((t) => t.category || "General")));

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Scripts &amp; Templates</h1>
          <p className="text-sm text-worked">
            Reusable call openers, voicemails, texts, and emails. {"{{first}}"} and {"{{me}}"} fill
            in from the lead when you use one from the drawer.
          </p>
        </div>
        <button
          onClick={() => setEditing({ ...BLANK })}
          className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          <Plus size={15} /> New
        </button>
      </div>

      {loading && <p className="text-sm text-later">Loading…</p>}

      {editing && (
        <div className="mb-5 rounded-2xl border border-brand/30 bg-white p-4 shadow-card">
          <div className="grid gap-2 sm:grid-cols-[1.4fr_0.8fr_0.8fr]">
            <input
              value={editing.name || ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Template name"
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
            <select
              value={editing.channel || "Call"}
              onChange={(e) => setEditing({ ...editing, channel: e.target.value })}
              className="rounded-lg border border-line px-3 py-2 text-sm"
            >
              {CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input
              value={editing.category || ""}
              onChange={(e) => setEditing({ ...editing, category: e.target.value })}
              placeholder="Category (e.g. T65)"
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
          </div>
          <textarea
            value={editing.body || ""}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            rows={6}
            placeholder="Script body. Use {{first}}, {{me}}, {{city}} for merge fields."
            className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(null)} className="rounded-lg border border-line px-4 py-2 text-sm text-worked hover:bg-paper">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {categories.map((cat) => (
          <div key={cat}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-later">{cat}</p>
            <div className="space-y-3">
              {templates
                .filter((t) => (t.category || "General") === cat)
                .map((t) => (
                  <div key={t.id} className="rounded-2xl border border-line bg-white p-4 shadow-card">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-ink">{t.name}</p>
                        <span className="rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-later">
                          {t.channel}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button onClick={() => copy(t)} title="Copy" className="rounded-md p-1.5 text-worked hover:bg-paper">
                          {copied === t.id ? <Check size={15} className="text-newlead" /> : <Copy size={15} />}
                        </button>
                        <button onClick={() => setEditing(t)} title="Edit" className="rounded-md p-1.5 text-worked hover:bg-paper">
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => remove(t.id)} title="Delete" className="rounded-md p-1.5 text-later hover:bg-paper hover:text-overdue">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{t.body}</p>
                  </div>
                ))}
            </div>
          </div>
        ))}
        {!loading && templates.length === 0 && (
          <p className="rounded-xl border border-dashed border-line bg-white p-8 text-center text-sm text-later">
            No templates yet. Add your call openers, voicemails, and texts here.
          </p>
        )}
      </div>
    </div>
  );
}
