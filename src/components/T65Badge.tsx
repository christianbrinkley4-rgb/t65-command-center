"use client";

// The month they turn 65, next to their name.
//
// This is the single most load-bearing fact in the book — it decides whether
// you're having an enrollment conversation or a "let's talk in the spring"
// conversation — so it appears beside the name on every surface: the Power
// List, the dial card, the search results, the calendar, the editor.
//
// It lived as six copies of the same JSX in six files, in three different
// stylings, so a lead read as urgent on one screen and neutral on the next.
// One component, one rule:
//
//   inside the window (hot / birthday month / closing) → solid, unmissable
//   four to six months out (approaching)               → tinted, worth noting
//   anything further out                               → quiet
//
// Most of the book is a year out. A badge that only appeared inside the IEP
// window left those rows unlabeled, which reads as "no birthday on file" — a
// different and much worse fact.

import { iepPhase, IEP_LABEL, turns65Label } from "@/lib/priority";

export default function T65Badge({
  birthday,
  size = "sm",
  /**
   * Say "No birthday on file" out loud instead of rendering nothing. Off for
   * dense rows, where hundreds of quiet badges would be noise; on wherever
   * you're about to talk to the person, because a missing badge there reads as
   * "not loaded yet" rather than "this record needs fixing".
   */
  showMissing = false,
  /**
   * Spell the phase out next to the month, for the door. Standing in someone's
   * driveway you have no hover and no time to decode a colour, and "T65 Sep
   * 2026 · window open" is the difference between a pitch and a pleasantry.
   */
  verbose = false,
}: {
  birthday: string | null;
  size?: "sm" | "md";
  showMissing?: boolean;
  verbose?: boolean;
}) {
  const label = turns65Label(birthday);
  const phase = iepPhase(birthday);
  const box =
    size === "md" ? "rounded px-2 py-0.5 text-xs" : "rounded px-1.5 py-0.5 text-[10px]";

  if (!label) {
    if (!showMissing) return null;
    return (
      <span className={`${box} shrink-0 bg-paper font-semibold text-later`}>
        No birthday on file
      </span>
    );
  }

  const tone =
    phase === "hot" || phase === "birthday" || phase === "closing"
      ? "bg-brand font-bold text-white"
      : phase === "approaching"
        ? "bg-brand-light font-semibold text-brand-dark"
        : "bg-paper font-semibold text-worked";

  return (
    <span
      className={`${box} ${tone} shrink-0`}
      title={phase && phase !== "outside" ? IEP_LABEL[phase] : `Turns 65 in ${label}`}
    >
      T65 {label}
      {verbose && phase === "birthday" ? " · this month" : ""}
      {verbose && phase === "hot" ? " · window open" : ""}
      {verbose && phase === "closing" ? " · closing" : ""}
    </span>
  );
}
