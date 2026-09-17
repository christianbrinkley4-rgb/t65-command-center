"use client";

import type { LeadWithBucket } from "@/lib/types";
import { nextPendingAction } from "@/lib/actions";
import { formatPhone } from "@/lib/phone";

export default function LeadRow({
  lead,
  onClick,
  rightNote,
  showAddress,
}: {
  lead: LeadWithBucket;
  onClick: () => void;
  rightNote?: string;
  showAddress?: boolean;
}) {
  const nextAction = nextPendingAction(lead._actions);
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-slate-50"
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
          <span className="truncate">{lead.name || "Unnamed"}</span>
          {lead._enr && lead._enr.status === "active" && (
            <span className="shrink-0 rounded bg-verify-50 px-1.5 py-0.5 text-[10px] font-semibold text-verify">
              Nurture · step {lead._enr.current_step}
            </span>
          )}
          {lead._dupe && (
            <span className="shrink-0 rounded bg-due-50 px-1.5 py-0.5 text-[10px] font-semibold text-due">
              Dupe phone
            </span>
          )}
          {lead.do_not_call && (
            <span className="shrink-0 rounded bg-overdue-50 px-1.5 py-0.5 text-[10px] font-semibold text-overdue">
              DNC
            </span>
          )}
        </p>
        <p className="truncate text-xs text-slate-500">
          {/* Street when we have one, city when we don't. You should never have
              to open a lead to find out where they live. (Plain text, not a
              maps link: this row is itself a button.) */}
          {lead.address
            ? `${String(lead.address).split(",")[0].trim()}, ${lead.city || lead.state || "NC"}`
            : `${lead.city || "—"}, ${lead.state || "NC"}`}
          {" · "}
          {formatPhone(lead.phone) || "no phone"}
          {lead.assigned_to && lead.assigned_to !== "Both" ? ` · ${lead.assigned_to}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-medium text-slate-600">{lead.status || "New"}</p>
        {rightNote ? (
          <p className="text-xs text-newlead">{rightNote}</p>
        ) : nextAction ? (
          <p className="max-w-40 truncate text-xs text-brand" title={`${nextAction.action_type} · ${new Date(nextAction.due_at).toLocaleString()}${nextAction.assigned_to && nextAction.assigned_to !== "Either" ? ` · ${nextAction.assigned_to}` : ""}`}>
            {nextAction.action_type} · {new Date(nextAction.due_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            {nextAction.assigned_to && nextAction.assigned_to !== "Either" ? ` · ${nextAction.assigned_to}` : ""}
          </p>
        ) : lead.home_value ? (
          <p className="text-xs text-slate-400">${Number(lead.home_value).toLocaleString()}</p>
        ) : null}
      </div>
    </button>
  );
}
