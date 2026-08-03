"use client";

// What opens when you tap a person's name, anywhere in the app.
//
// Christian: "when we click a name under anything, on calendar or anywhere it
// should show everything like we are going to call them, the whole lead card
// everywhere." Tapping a name used to open the edit form on seven different
// pages — a wall of inputs, with the address and the call history buried below
// the fold. You almost never open a lead to edit a field. You open it because
// you are about to talk to them.
//
// So the card comes first everywhere, and the editor is one tap behind it.
//
// It also re-resolves the lead from the live book on every render. Pages hold
// whichever row object they happened to be rendering when you tapped, and after
// you log a result that copy is stale — it would still show the status and the
// history from before the call. Looking it up by id each time means the panel
// is always showing what the database actually says.

import { useEffect, useState } from "react";
import { useApp } from "@/lib/context";
import LeadCard from "@/components/LeadCard";
import EditDrawer from "@/components/EditDrawer";
import type { LeadWithBucket } from "@/lib/types";

export default function LeadPanel({
  lead,
  onClose,
  /** "editor" for controls that explicitly say they open the editor. */
  openTo = "card",
}: {
  lead: LeadWithBucket | null;
  onClose: () => void;
  openTo?: "card" | "editor";
}) {
  const { leads } = useApp();
  const [editing, setEditing] = useState(openTo === "editor");

  // Closing and reopening someone else must not land you back in the editor —
  // and a control that promised the editor must still deliver it.
  //
  // Keyed on the ID, not the object: this component hands EditDrawer a row it
  // re-resolves from the live book, so `lead` is a new object on every reload,
  // and the book reloads whenever either agent touches anything. Depending on
  // the object meant that opening the full record and starting to type got you
  // thrown back to the card the moment anyone logged a call.
  useEffect(() => {
    setEditing(lead ? openTo === "editor" : false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id, openTo]);

  if (!lead) return null;
  const live = leads.find((l) => l.id === lead.id) || lead;

  if (editing) {
    return (
      <EditDrawer
        lead={live}
        onClose={() => {
          setEditing(false);
          onClose();
        }}
      />
    );
  }

  return <LeadCard lead={live} onClose={onClose} onOpenFullRecord={() => setEditing(true)} />;
}
