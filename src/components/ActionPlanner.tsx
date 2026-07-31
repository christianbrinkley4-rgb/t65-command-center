"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ACTION_TYPES, ACTION_ASSIGNEES, type ActionAssignee, type ActionType } from "@/lib/types";
import type { ActionDraft } from "@/lib/actions";

type EditableAction = {
  action_type: ActionType;
  due_at: string;
  note: string;
  assigned_to: ActionAssignee;
};

function toInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function actionInDays(type: ActionType, days: number, note = ""): ActionDraft {
  const due = new Date();
  due.setDate(due.getDate() + days);
  return { action_type: type, due_at: toInputValue(due), note, assigned_to: "Either" };
}

export default function ActionPlanner({
  initialActions,
  onSave,
  onCancel,
  saving = false,
  saveLabel = "Save actions",
}: {
  initialActions?: ActionDraft[];
  onSave: (actions: ActionDraft[]) => Promise<void>;
  onCancel?: () => void;
  saving?: boolean;
  saveLabel?: string;
}) {
  const [rows, setRows] = useState<EditableAction[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(
      (initialActions || []).map((action) => ({
        action_type: action.action_type,
        due_at: action.due_at,
        note: action.note || "",
        assigned_to: action.assigned_to || "Either",
      }))
    );
    setError(null);
  }, [initialActions]);

  function patchRow(index: number, patch: Partial<EditableAction>) {
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  async function save() {
    if (rows.some((row) => !row.due_at)) {
      setError("Choose a date and time for each planned action, or remove the blank row.");
      return;
    }
    setError(null);
    await onSave(rows);
  }

  return (
    <div className="rounded-xl border border-brand/20 bg-brand-light/30 p-3">
      <p className="text-xs font-semibold text-brand-dark">Plan the next actions</p>
      <p className="mt-0.5 text-xs text-slate-500">These are reminders only—nothing sends automatically.</p>

      <div className="mt-3 space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_28px] gap-1.5">
            <select
              value={row.action_type}
              onChange={(event) => patchRow(index, { action_type: event.target.value as ActionType })}
              className="min-w-0 rounded-md border border-line bg-white px-2 py-2 text-xs"
            >
              {ACTION_TYPES.map((type) => <option key={type}>{type}</option>)}
            </select>
            <select
              value={row.assigned_to}
              onChange={(event) => patchRow(index, { assigned_to: event.target.value as ActionAssignee })}
              className="min-w-0 rounded-md border border-line bg-white px-2 py-2 text-xs"
              title="Who should do this"
            >
              {ACTION_ASSIGNEES.map((who) => (
                <option key={who} value={who}>
                  {who}
                </option>
              ))}
            </select>
            <input
              type="datetime-local"
              value={row.due_at}
              onChange={(event) => patchRow(index, { due_at: event.target.value })}
              className="min-w-0 rounded-md border border-line bg-white px-2 py-2 text-xs"
            />
            <button
              type="button"
              onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}
              className="rounded-md text-slate-400 hover:bg-white hover:text-overdue"
              title="Remove action"
            >
              <Trash2 size={14} className="mx-auto" />
            </button>
            <input
              value={row.note}
              onChange={(event) => patchRow(index, { note: event.target.value })}
              placeholder="Optional note, e.g. ask about the mailer"
              className="col-span-3 rounded-md border border-line bg-white px-2 py-1.5 text-xs"
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() =>
          setRows((current) => [
            ...current,
            { action_type: "Call", due_at: actionInDays("Call", 1).due_at, note: "", assigned_to: "Either" },
          ])
        }
        className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-dark hover:underline"
      >
        <Plus size={13} /> Add another action
      </button>
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving} className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:bg-white">
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-60"
        >
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
    </div>
  );
}
