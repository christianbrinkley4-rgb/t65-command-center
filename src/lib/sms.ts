// Handing a text off to the phone's own messaging app, with the message
// already written.
//
// Texting is the second half of every no-answer: the voicemail says who you
// are, the text is the thing they can actually reply to without calling a
// stranger back. It was being done entirely outside the app — leave the
// session, open Messages, copy the number across, retype the same sentence —
// which is most of a minute per lead on top of a dial that averages 54
// seconds. Done a hundred times a day that is the single largest block of
// time in the calling day that produces nothing.
//
// There is no sending here and there is no gateway. Same model as the Call
// button: the app writes the message, the handset sends it. Nothing to
// register, nothing to pay for, and the text comes from the number they'd call
// back anyway.

import { supabase } from "./supabaseClient";
import { logActivity, todayStr } from "./sequences";
import { canonicalPhone } from "./phone";
import type { LeadWithBucket } from "./types";

/**
 * The `sms:` URL, which the two platforms spell differently.
 *
 * iOS wants `sms:+1336…&body=`, Android wants `sms:+1336…?body=`. Get it wrong
 * and the message app opens with an empty draft, which looks like the feature
 * half-working and quietly puts the typing back on you. Unknown platforms get
 * the `?` form, which is the one in the RFC.
 */
export function smsHref(phone: string, body: string): string | null {
  const d = canonicalPhone(phone);
  if (d.length !== 10) return null;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const sep = /iPhone|iPad|iPod|Macintosh/i.test(ua) ? "&" : "?";
  return `sms:+1${d}${sep}body=${encodeURIComponent(body)}`;
}

/**
 * Whether we have written permission to text this person.
 *
 * Right now this is false for every lead in the book, which is the honest
 * state of things: nothing in a bought T65 list carries consent, and the OSCR
 * feed explicitly doesn't (see DEFTSALES_INTEGRATION). It turns true one
 * person at a time, when someone on a live call says yes to "can I text you
 * the details" — see grantSmsConsent.
 */
export function canText(lead: Pick<LeadWithBucket, "sms_consent" | "do_not_call">): boolean {
  return Boolean(lead.sms_consent) && !lead.do_not_call;
}

/** Why the Text button is off, in the words you'd use to fix it. */
export function textBlockReason(
  lead: Pick<LeadWithBucket, "sms_consent" | "do_not_call" | "phone" | "phone2">
): string | null {
  if (lead.do_not_call) return "Asked not to be contacted.";
  if (!canonicalPhone(lead.phone) && !canonicalPhone(lead.phone2)) return "No number on file.";
  if (!lead.sms_consent) {
    return "No texting consent on file. Ask on the call — \"can I text you the details?\" — and tap Got consent.";
  }
  return null;
}

/**
 * The two texts that get sent, in the order they get sent.
 *
 * `vm` is the one that matters. It goes out inside a minute of the voicemail,
 * while the missed call is still on their screen, and it gives a 64-year-old
 * who will not call an unknown number back a way to answer. `intro` is for
 * someone who picked up and asked for details.
 *
 * Both name Bankers Life and both carry an opt-out, because a Medicare
 * marketing text that does neither is a compliance problem regardless of who
 * typed it.
 */
export const SMS_KIND = {
  vm: {
    key: "vm",
    label: "After voicemail",
    outcome: "Text - after voicemail",
    body: (first: string, me: string) =>
      `Hi ${first}, ${me} with Bankers Life in Greensboro — just left you a voicemail. You're coming up on 65 and I help neighbors sort out the Medicare part before the mail starts. Happy to answer a question right here by text if that's easier. Reply STOP to opt out.`,
  },
  intro: {
    key: "intro",
    label: "Details after a talk",
    outcome: "Text - after conversation",
    body: (first: string, me: string) =>
      `Hi ${first}, ${me} with Bankers Life — good talking with you. Here's my number if anything comes up before we meet. Reply STOP to opt out.`,
  },
} as const;

export type SmsKind = keyof typeof SMS_KIND;

export function smsBody(kind: SmsKind, lead: LeadWithBucket, me: string): string {
  const first = (lead.name || "").trim().split(/\s+/)[0] || "there";
  return SMS_KIND[kind].body(first, me);
}

/**
 * Record that they said yes, on the call, in their own words.
 *
 * This is the part worth building. Every text going out today goes to someone
 * whose record says nothing about permission, so there is no way to answer a
 * supervision question about any of them. Asking "can I text you the details?"
 * costs four seconds on a call that is already happening, and the yes is worth
 * keeping: it is what makes the message legitimate, and a list of people who
 * asked to be texted is worth more than the whole cold book.
 *
 * Dated, attributed, and appended to the notes rather than replacing them, so
 * the record shows when and who heard it.
 */
export async function grantSmsConsent(lead: LeadWithBucket, me: string): Promise<void> {
  const stamp = todayStr();
  const line = `[${stamp} consent · ${me}] Verbal OK to text, given on a call.`;
  const { error } = await supabase
    .from("leads")
    .update({
      sms_consent: true,
      raw_notes: `${line}${lead.raw_notes ? "\n" + lead.raw_notes : ""}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id);
  if (error) throw error;
  await logActivity(lead.id, "Consent", "Texting - verbal on call", null, me);
}

/** Log the text that just left the handset. Best-effort, like the dial. */
export async function logText(lead: LeadWithBucket, kind: SmsKind, me: string): Promise<void> {
  await logActivity(lead.id, "Text", SMS_KIND[kind].outcome, null, me);
}
