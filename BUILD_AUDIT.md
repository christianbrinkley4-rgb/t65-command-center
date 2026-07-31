# T65 Command Center — Full Build Audit

Audit date: July 20, 2026. Scope: every file in `src/`, the live Supabase schema, and the workflow of two Bankers Life agents (Christian + Will) doing Medicare/T65 prospecting in Greensboro. Goal: find everything missing or weak, then fix what's fixable in this architecture.

## Ground truth from the live database

- 2,729 leads. 5 have no phone (invisible to any call queue). 278 have no birthday (invisible to T65 Radar and the IEP boost). **0 have an email** — every Email step in every sequence is dead weight until emails get captured.
- Leads are already split: Christian 1,321, Will 1,131, Both 277.
- 340 closed, 13 of them DNC. 0 appointments and 0 sales recorded yet (those features are new, so that's expected, not a bug).

## What the build already does well

The core loop is genuinely strong and beats a generic CRM for this two-person use case: a priority "Next Up" queue that never runs dry, one-tap dispositions that write the lead + append-only history + advance the nurture sequence in one motion, a flexible per-lead action planner, editable nurture sequences, a T65 IEP radar, CSV import, duplicate-phone detection, and a shared login with per-person activity stamping. Nothing auto-sends, which keeps it clean on TCPA. At $0/month against GoHighLevel's $97+ and VanillaSoft's ~$100/seat, the value is real.

## Gaps found, ranked by impact on prospecting, and the decision on each

### Built in this pass

1. **No power-dialing speed.** Every disposition was a mouse click. VanillaSoft's whole pitch is 24-32 dials/hour vs ~8, and keyboard-driven dispositioning is how you get there. **Fixed:** number-key hotkeys on Next Up (1-7 dispositions, A appointment, S sold, E editor, X skip, U undo), so a full call-and-log cycle never needs the mouse.

2. **No undo.** One-tap dispositioning with no undo means a misclicked DNC permanently closes a lead. **Fixed:** U reverts the last lead's status/stage/follow-up/dials to their pre-disposition snapshot and logs the correction.

3. **No Medicare compliance tracking.** This is the single biggest thing a generic CRM lacks for Medicare specifically, and AgencyBloc's main selling point. CMS requires a Scope of Appointment before an MA/PDP sales appointment and permission-to-contact before outreach; DNC is both federal and internal. **Fixed:** added `do_not_call`, `soa_on_file`, `soa_date`, `ptc_on_file` columns, a compliance section in the drawer, red flags on cards, and a hard DNC that removes a lead from every call queue (stronger than the old "Closed - DNC" status, which a status edit could accidentally undo).

4. **The funnel stopped at "appointment set."** No held-vs-no-show, so you couldn't see show rate or true appointment-to-sale conversion. **Fixed:** appointment-outcome buttons (Held / No-Show / Sold) in the drawer and a Set → Held → Sold funnel with show-rate in Stats.

5. **No source ROI.** Stats counted leads per source but not which source produces appointments and sales. This is exactly the Nextdoor-vs-Facebook-vs-SmartAsset decision CLAUDE.md says is live. **Fixed:** a per-source table in Stats (leads, worked, appointments, sold, worked-to-appointment %).

6. **No Medicare seasonality.** The app knew each lead's IEP but nothing about AEP (Oct 15-Dec 7) or OEP (Jan 1-Mar 31), the windows when the whole book can switch plans. **Fixed:** a season banner on Next Up and Today that counts down to AEP and flags when you're inside an enrollment window.

7. **Data quality was invisible.** 5 no-phone, 278 no-birthday, 0-email, and 52 duplicate-phone groups were buried. **Fixed:** a Data Health panel on Stats that surfaces each bucket with one-click access to fix them, so nothing is silently lost.

8. **Search was name/phone only.** **Fixed:** search now also matches city, source, and email.

9. **No daily activity goal.** The dashboard counted dials but set no target. **Fixed:** a configurable daily dial goal with a progress bar per person.

### Deliberately not built, and why

- **Two-way SMS, email sending, auto-dialer, call recording.** All require a server and a telephony/email integration (Telnyx is in the vault for calling). This app is a static export with client-side Supabase by design, so these belong in a separate phase with a real backend. Building fake versions would be worse than not having them. CMS also requires MA/PDP sales calls to be recorded, which is a telephony-side capability, not a CRM field.
- **Push/appointment reminders.** No server to send them. The Today appointment strip and the queue cover this in-app.
- **Commission/APC dollar tracking.** Explicitly removed at Christian's request.
- **Call scripts inside the app.** The vault's INSURANCE_BRAIN.md is the authoritative script source; duplicating scripts here would drift out of sync. Better to keep one source of truth.
- **Federal DNC scrubbing.** A compliance-vendor service, not something a static app can do. The internal DNC flag is the in-app half.

## Honest verdict

For two agents doing local Medicare/T65 prospecting with no budget, after this pass I can't identify a commercial CRM that would serve them better without adding a paid backend for live SMS/dialer. GoHighLevel wins only on server-side automation you're intentionally avoiding on compliance grounds; AgencyBloc wins only on post-sale commission accounting, which isn't the prospecting job. The one true limit is telephony: the day two-way texting and recorded calls matter, that's a backend project, and it's the right next investment, not a gap in this build.
