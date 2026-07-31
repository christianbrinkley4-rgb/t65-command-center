# DeftSales / SmartAsset AMP ↔ CRM

Recon done July 24, 2026 by driving the live SmartAsset AMP session (amp.smartasset.com) with Claude in Chrome, read-only — no test imports, no test campaigns, no live calls placed. The customer-facing brand is "SmartAsset AMP"; the phone/dialer engine underneath still calls itself "Deft" internally (Twilio AMD settings literally say "Deft Fast Call recording"). This is DeftSales, white-labeled.

## The core constraint: no API

There is no API key, developer console, or webhook anywhere in the account. Leads enter DeftSales exactly three ways: the native SmartAsset survey feed (automatic, already flowing — 178 leads on this account, consent implicit in the survey), manual single "Add Lead," or a human running the CSV import wizard. That means the T65 Command Center CRM cannot push leads into DeftSales programmatically. The link is a human-run export/import cycle, same shape as the existing OSCR pattern: CRM filters and scores, produces a CSV in DeftSales's template, a person drags it into the Import wizard.

## Import CSV format (confirmed from the platform's own template download)

```
FirstName,LastName,Email,PhoneNumber,ZipCode
John,Doe,email@email.com,+10001112233,12345
```

Phone must be E.164 (`+1` + 10 digits). Import path: Leads → "…" → Import → 3-step wizard (Select CSV → Verify Leads → Campaign Details) — the campaign/lead-type gets assigned at step 3, not the CSV itself. Dedup behavior on re-import is **unverified** — test with 2-3 known leads before trusting a real batch not to duplicate.

Leads already in the system can skip the CSV path entirely: select on the Leads grid → Bulk Edit → Assign Campaign (also: Add Tags, Push to CRM, Stop/Resume Campaign, Delete).

## FastCall fires on Lead Type, not on campaign step

This is the detail that drives the whole build. FastCall ("Deft Fast Call") is Twilio-based auto-dial with answering-machine detection, and it triggers when a new lead lands under a **Lead Source / Lead Type row that has Fast Call = Enabled** — tied to that row's Assigned Number and Assigned User (round-robin available). It is not something you turn on inside a campaign sequence. Recording is on by default (AMD delay setting confirms it).

Practical implication: give OSCR/T65 imports their own Lead Type (e.g. "T65 OSCR Import"), separate from whatever Lead Type the native SmartAsset feed uses, with its own number/user and its own Fast Call toggle. That isolates OSCR-sourced calling from SmartAsset-sourced calling completely — which matters because they sit on opposite sides of the consent line (see below).

AMD tuning lives at Settings → Company → Phone Numbers → Twilio AMD Settings: four presets (Minimize Voicemails / Balanced / Reduced Hang Ups [current default] / Minimize Hang Ups) plus a raw-parameter custom panel. Numbers are on a Twilio Business Profile, STIR/SHAKEN approved, Voice Integrity approved — a cleaner starting reputation than the burned direct Telnyx DID documented in [[t65-crm-v2-state]].

## Campaigns are linear, no branching

One campaign type: a time-delayed sequence mixing Email / Text / "Call" (Next-Call reminder) steps, delay set per step in Minute/Hour/Day units. No conditional logic. A campaign has an "Is approved" gate (unchecked by default) and an "Email to Compliance" button — DeftSales itself expects a compliance review before a sequence goes live. Texting is toggled OFF account-wide right now, independent of any per-lead consent.

## The consent line this account already enforces

Lead record shows `Terms_of_service: True` and a `Compliance ID` GUID — that's the SmartAsset survey acting as TCPA consent for native leads. OSCR/T65 leads have no equivalent consent on file (confirmed separately: 0 of leads in the SQLite lead-intake engine have SMS/email consent — see `C:\dialer\lead_intake\README.md`). Do not put OSCR-sourced leads on any campaign step that sends email or text. The safe design for a "T65 OSCR Import" Lead Type is a **call-only campaign** — Next-Call reminder steps timed off the cadence already defined in `C:\dialer\lead_intake\cadence_seed.sql` — with FastCall enabled for the speed-to-lead win, and nothing else. Submit it through Email to Compliance before flipping "Is approved."

Open question, not yet answered: whether importing non-SmartAsset (OSCR-sourced) leads into DeftSales is inside the terms of the SmartAsset/DeftSales seat at all. Worth a direct check with William or SmartAsset support before running this at real volume — the account was provisioned around the SmartAsset lead relationship, and it's unconfirmed whether outside lead batches are permitted.

## Redtail sync is push-only, automatic

Settings → Company → CRM shows Redtail connected (account BNK_PQ13WCHA). The "Configure Redtail" screen maps, for contacts created in Redtail: Address, Status (Prospect / Active Fee-Based Client / Do Not Contact / etc.), Source, Category, Servicing/Writing Advisor roles, Tags, Workflow templates, Activity templates, plus toggles to log emails/texts/calls as Redtail notes. Confirmed via the sample lead's timeline ("Contact imported to Redtail") that this fires automatically per lead on creation — no separate action needed once the mapping is set. No inbound Redtail → AMP sync exists. Recommend setting Source = something distinct (e.g. "OSCR T65") for OSCR-origin leads so Redtail can tell the two lead worlds apart later.

## Compliance controls observed

- Quiet hours: Settings → Company → Time → Campaign Scheduling, weekdays 8am–9pm, weekends off by default (note: immediate steps within 60 min of lead receipt still fire on weekends regardless).
- Per-lead Unsubscribe action; campaign-level "Include unsubscribe" checkbox.
- No A2P/10DLC SMS registration status page found — likely why texting is off account-wide.

## Data model

Standard lead fields: Name, Phone, Email, ZipCode, Source, Lead Type, Assigned Campaign/User/Number, Time Zone, Compliance ID. SmartAsset-fed leads carry ~30 additional questionnaire custom fields (retirement timing, income, assets, homeowner status, etc.) that are **read-only** in the UI and appear to be tied to the SmartAsset intake schema — not something a CSV import can populate, and no company-wide custom-field builder was found. CSV-imported leads will only ever carry the 5 template fields.

## Reporting

Three dashboards: Activity Report (calls, consistency, response times, idle-lead %), Pipeline Report (leads delivered, responded, scheduled meetings, conversion by maturity bucket), and per-campaign Analytics (Sent/Answers/Bookings by step, filterable by Lead Source/Type). No FastCall-specific answer-rate metric, but per-step call analytics will capture it once used.

## First real batch

25 leads pulled from Will's `TRACKER_Will_March.xlsm` (March T65 birthdays, home-value sorted) into `03_Wealth_and_Career/Bankers_Life/07_Data_And_Prospect_Lists/DeftSales_Import_Will_March_T65_25_2026-07-24.csv` — superseded same day, see below.

## Master batch (supersedes the 25)

Christian added two custom fields in DeftSales for City and Address (exact mechanism unconfirmed — recon on July 24 found lead custom fields read-only/SmartAsset-schema-only, so this is new since then; verify how they map during the Verify Leads step of import). He deleted the standalone 25-lead batch and asked for the full list instead, folding the 25 in rather than excluding them.

`DeftSales_Import_Will_March_T65_MASTER_2026-07-24.csv` — 359 leads, every March-birthday row with `NEXT ACTION = DIAL` (never attempted) plus the 4 legitimate retries from the original 25 (bad time / no VM / VM left / vacation callback now overdue). Still excludes the 2 leads flagged `dsc#` (disconnected) and `wrn#` (wrong number) — dead numbers, no reason to feed them to an auto-dialer regardless of list scope. Columns: `FirstName,LastName,Email,PhoneNumber,ZipCode,City,Address`. All 359 phone numbers validated as 10 digits, zero duplicates. ZipCode is blank for 92 rows where the sheet's Address field is street-only (no city/state/zip suffix) — City and Address columns still carry that context, so these were kept rather than dropped. Email is blank for all 359 (tracker never captured it) — still unverified whether DeftSales requires non-empty email on import.

## Still open

- CSV import dedup behavior on re-import (untested).
- Whether email is a required field for import.
- Whether the SmartAsset/DeftSales seat terms permit non-SmartAsset lead batches.
- The Redtail Source/Status mapping for OSCR-origin leads hasn't been set yet — still using whatever default applies to the one existing Lead Type.
- No Lead Type / campaign / Fast Call config has been created yet for OSCR/T65 leads — this doc describes the mechanism, not a finished setup.
