# Mock-Day Audit — 4 agents, brutally honest

Date: July 22, 2026. Four independent agents ran a simulated full day on the CRM from four angles: the Power List calling loop, follow-up/scheduling integrity, import/data correctness, and Medicare compliance + analytics. Below is the honest verdict, the critical findings, what got fixed in this pass, and what's deferred with reasons.

## The three things that were genuinely dangerous

1. **DNC wasn't airtight.** The queue excluded Do-Not-Call leads, but the drawer's call buttons (reachable from Search and Today) dialed anyway, DNC was stored per-record so a duplicate/twin phone stayed callable, and re-importing a DNC person under a new source resurrected them as callable. This is a real TCPA/CMS violation risk for a newly licensed agent.
2. **The CSV importer could dial the wrong person.** A single stray double-quote in an unquoted cell (an inches mark, a nickname in quotes, a `6" pipe` note) flipped the parser into quote mode and shifted every following column — so a phone number could land against a different person's name. Plus phone numbers weren't canonicalized, so `1-336…`, `+1…`, and `…x102` dodged dedup and got dialed twice by two agents.
3. **Two agents, one shared queue, no live sync.** Both of you opening the app saw the exact same deterministically-ranked top lead and dialed into each other, stale data let one of you overwrite the other's update (even un-sell a sale), and switching tabs resurfaced the whole morning's worked leads to be re-dialed.

## Fixed in this pass

Compliance / legal:
- DNC is now suppressed by **normalized phone**, not row id: a twin lead sharing a DNC number is auto-suppressed from the queue, and the drawer **blocks the dial buttons** on any DNC (or DNC-twin) lead instead of just showing a banner.
- The **Import screen scrubs Do-Not-Call numbers** — they're counted and blocked, never re-added as fresh callable leads.
- **Calling window is enforced**, not just displayed: outside 8am–9pm the phone links and one-tap call results are disabled on the Power List.
- **Scope of Appointment guard**: booking an appointment with no SOA on file now warns (CMS requires one before an MA/PDP appointment).

Data correctness:
- **CSV parser** now follows RFC 4180 — a quote only opens a field at the start of an empty cell; a stray mid-cell quote is a literal. No more column-shifting.
- **Canonical phone** everywhere (dedup, duplicate flag, DNC, import): strips extensions, drops a country-code 1, reduces to the last 10 digits.
- **Date parsing** now handles Excel serial numbers, year-only DOBs, and trailing times, so birthdays stop silently vanishing off the T65 radar.
- **Column auto-map** dropped the `st`→state alias (it was mis-mapping first names/streets) and now maps each source column to at most one field.

Scheduling integrity:
- **UTC-vs-local bug fixed**: "today" and follow-up dates are computed from the local calendar, and action timestamps are normalized to local days — so an evening callback no longer lands a day late or shows on the wrong day.
- **`matchesWho` fixed**: a callback left at the default "Either"/"Both" no longer vanishes when you filter to your own name. A person's view is now the shared pool minus what's been handed exclusively to the other agent.
- Dispositioning no longer **completes the other agent's** soonest action — only your own (or a shared) action.
- The overdue-action priority boost (which was always zero) now actually ranks older-overdue first.

Power List root cause:
- **Live sync**: a Supabase realtime subscription (replication enabled on `leads` + `lead_actions`) pulls fresh data when either agent changes something, so you stop working stale data and the same lead.
- **Worked-this-session survives navigation**: the worked set moved into shared context, so switching tabs no longer resurrects your morning's calls.
- **Duplicate co-hide**, **phone2 fallback dial**, and **a bare note no longer hides a still-due lead**.

Requested feature:
- **Segment + source filter** on the Power List (All / Overdue / Due today / This week / T65 hot / Never dialed, plus a source dropdown) to run a themed calling session.

Analytics trust:
- "Worked" is no longer inflated by opening-and-saving a lead (editing stopped stamping `last_contact_date`), the daily dial goal no longer double-counts a single call, and the season banner points at OEP (not next year's AEP) in December.

## Deferred, with reasons (honest)

- **Strict optimistic-concurrency guard** (block a write when the row changed under you). Realtime sync mitigates most of it; a hard `updated_at` guard needs careful UX so it doesn't block legitimate writes. Next.
- **Undo does not yet restore an exited sequence or completed action** — only the lead's own fields. A mis-tapped "Not interested" on a sequenced lead reverts status but leaves the nurture exited. Needs a deeper snapshot. Flagged, not fixed.
- **Analytics overhaul**: cost-per-lead / cost-per-appointment (there's no spend input yet, so "ROI" is really conversion counts), weekly time-series trends, and a per-person appointments/sold leaderboard. Real gaps for the money decision and for two competitive agents — worth a dedicated pass.
- **CMS call-recording acknowledgement** and **consent (PTC) gating on text/email sequences** — flagged as compliance exposure; needs product decisions on how strict to be.
- **Smart Capture parser** has minor over-eager matches ("a week" inside "wait a week or two"); low impact, and real Gemini (once the key is added) sidesteps it.

## Lead data reconciled

The four files were almost entirely the leads already loaded (same six monthly trackers, SmartAsset, prospect sheet). Net change: **178 emails backfilled** onto existing leads (the database had zero — this reactivates the Email steps in sequences) and **3 brand-new leads** inserted. No statuses or notes were overwritten from Excel — the app is the system of record now, and a blind overwrite would have clobbered in-app work. Database: 2,732 leads, 180 with email.
