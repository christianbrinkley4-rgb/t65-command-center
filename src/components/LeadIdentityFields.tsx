"use client";

// Who the person actually is: name, numbers, birthday, address.
//
// None of these were editable anywhere in the app. That left the "Wrong Info"
// disposition — key 8 on the phone, a button at the door, a whole segment on
// the Power List — as a road to nowhere: you could mark a record as wrong and
// then had no way to make it right without opening the Supabase table editor.
// The segment blurb said "fix what's wrong" and there was nothing to fix it
// with.
//
// The same fields are the new-lead form, because typing someone in from church
// and correcting a bad tracker row are the same nine boxes.
//
// The birthday deserves its own note. It is not a birthday field, it is the
// T65 field: everything in this book keys off the month they turn 65, and a
// lead with no birthday is invisible to the Radar, gets no IEP boost, and can
// never be filtered by month. So the moment you type one, this says what it
// bought you.

import { CalendarClock, TriangleAlert } from "lucide-react";
import { canonicalPhone } from "@/lib/phone";
import { turns65Label } from "@/lib/priority";
import type { Lead } from "@/lib/types";

export type LeadIdentity = {
  name: string;
  phone: string;
  phone2: string;
  email: string;
  birthday: string;
  address: string;
  city: string;
  zip: string;
  county: string;
};

export const emptyIdentity: LeadIdentity = {
  name: "",
  phone: "",
  phone2: "",
  email: "",
  birthday: "",
  address: "",
  city: "",
  zip: "",
  county: "",
};

export function identityFromLead(lead: Lead): LeadIdentity {
  return {
    name: lead.name || "",
    phone: lead.phone || "",
    phone2: lead.phone2 || "",
    email: lead.email || "",
    birthday: lead.birthday ? String(lead.birthday).slice(0, 10) : "",
    address: lead.address || "",
    city: lead.city || "",
    zip: lead.zip || "",
    county: lead.county || "",
  };
}

/** Trimmed, with empties as nulls so the database holds "unknown", not "". */
export function identityPatch(id: LeadIdentity): Partial<Lead> {
  const v = (s: string) => (s.trim() ? s.trim() : null);
  return {
    name: v(id.name),
    phone: v(id.phone),
    phone2: v(id.phone2),
    email: v(id.email),
    birthday: v(id.birthday),
    address: v(id.address),
    city: v(id.city),
    zip: v(id.zip),
    county: v(id.county),
  };
}

export function identityChanged(a: LeadIdentity, b: LeadIdentity): boolean {
  return (Object.keys(a) as (keyof LeadIdentity)[]).some((k) => a[k].trim() !== b[k].trim());
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  wide = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
      />
      {hint && <p className="mt-1 text-[11px] text-later">{hint}</p>}
    </div>
  );
}

export default function LeadIdentityFields({
  value,
  onChange,
  /**
   * Canonical phone numbers already in the book, minus this lead's own. Typing
   * a number that's already there is how you create the duplicate you'd have
   * to merge later, so say it while it's still one keystroke to undo.
   */
  takenPhones,
}: {
  value: LeadIdentity;
  onChange: (next: LeadIdentity) => void;
  takenPhones?: Set<string>;
}) {
  const set = (k: keyof LeadIdentity) => (v: string) => onChange({ ...value, [k]: v });

  const digits = canonicalPhone(value.phone);
  const shortPhone = digits.length > 0 && digits.length < 10;
  const collides = digits.length === 10 && takenPhones?.has(digits);
  const t65 = value.birthday ? turns65Label(value.birthday) : null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Name" value={value.name} onChange={set("name")} placeholder="First Last" wide />

      <div>
        <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
          Phone
        </label>
        <input
          type="tel"
          value={value.phone}
          onChange={(e) => onChange({ ...value, phone: e.target.value })}
          placeholder="(336) 555-0142"
          className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        {shortPhone && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-due">
            <TriangleAlert size={11} aria-hidden /> Only {digits.length} digits — this won&apos;t dial.
          </p>
        )}
        {collides && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-due">
            <TriangleAlert size={11} aria-hidden /> Another lead already has this number.
          </p>
        )}
      </div>

      <Field
        label="Second number"
        value={value.phone2}
        onChange={set("phone2")}
        type="tel"
        placeholder="Landline, spouse, work"
      />

      <div>
        <label className="block text-[11px] font-medium uppercase tracking-wide text-worked">
          Date of birth
        </label>
        <input
          type="date"
          value={value.birthday}
          onChange={(e) => onChange({ ...value, birthday: e.target.value })}
          className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        <p className="mt-1 flex items-center gap-1 text-[11px] text-later">
          <CalendarClock size={11} aria-hidden />
          {t65
            ? `Turns 65 in ${t65} — on the Radar and filterable by month.`
            : "Without this they're invisible to the T65 Radar and get no IEP priority."}
        </p>
      </div>

      <Field label="Email" value={value.email} onChange={set("email")} type="email" placeholder="Captured on a real conversation" />

      <Field
        label="Street address"
        value={value.address}
        onChange={set("address")}
        placeholder="1729 Neelley Rd"
        hint="Drives the door route and the parcel home-value match."
        wide
      />

      <Field label="City" value={value.city} onChange={set("city")} placeholder="Greensboro" />

      <div className="grid grid-cols-2 gap-3">
        <Field label="ZIP" value={value.zip} onChange={set("zip")} placeholder="27405" />
        <Field label="County" value={value.county} onChange={set("county")} placeholder="Guilford" />
      </div>
    </div>
  );
}
