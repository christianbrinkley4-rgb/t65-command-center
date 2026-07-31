# OSCR ↔ Command Center

Built July 23, 2026. The goal: stop running two systems. OSCR stays the system of record; the Command Center becomes the working layer on top of it.

## The division of labor

| OSCR owns | Command Center owns |
|---|---|
| Lead ownership and assignment | The daily queue and what to work next |
| Carrier truth: DNC, consent, callable, suppression | The dialer, call outcomes, talk time |
| Appointment score, lead source, latest disposition | Notes, tags, sequences, callbacks |
| Compliance of record | Analytics: answer rate, source ROI, pipeline |

Neither duplicates the other. OSCR tells us who we may contact; the CRM runs the day and reports back.

## Why there's no scraper (and what to ask for instead)

From the OSCR pull plan: *"Pega forbids automated pulling, and direct browser automation is blocked until you are assigned to `SSO_Pega - Prod - OSCR2`."* Automating against that risks BSPN access and an appointment, so the bridge runs on sanctioned exports.

The legitimate unlock is an access request, not a build. Ask the branch admin for the **`SSO_Pega - Prod - OSCR2`** access group so you can run your own reporting/exports on your assigned book. With it, the export step becomes scriptable and the manual clicks go away — at which point the automated pull gets built.

Two other supported paths worth asking about:
- **Scheduled Pega report / bulk extract** run by a branch admin — scales past the ~1,000-row render cap far better than clicking.
- **New Web Lead Notification Recipients** — OSCR can email you on new web leads. An inbox watcher parsing those gives speed-to-lead in minutes with no export at all.

## The daily loop

**In (OSCR → CRM).** Export your slices (the seven county filters, or the two daily ones), then drag any of them into the **Import** tab. No configuration:

- The export is auto-detected as OSCR the moment it has a lead-id column. Header spellings are normalized, so any saved view, filter, or report shape works.
- Leads **upsert on OSCR lead ID** — re-exporting the same county every day updates those records instead of duplicating them. Overlapping slices are free.
- **Compliance is inherited from OSCR**: `phone status / DNC`, `callable (Y/N)`, and `suppressed` set do-not-call; `sms consent flag` and `email consent flag` set consent. The dialer then refuses to call a lead OSCR says is off-limits, and text/email steps stay blocked without consent on file.
- Your CRM work is protected: statuses, notes, tags, follow-ups, and sequences are never overwritten by a sync, and an empty OSCR cell never wipes a populated CRM field.
- Do-not-call only ever gets **set** by a sync, never cleared. If you DNC someone locally, an OSCR export can't un-DNC them.

**Out (CRM → OSCR).** Every disposition on an OSCR-sourced lead flags it for write-back.

1. Power List → **Needs OSCR update** segment shows everything dispositioned since your last sync (including closed/DNC leads, which the normal queue hides).
2. Work down it in OSCR, or hit **Export** for a CSV led by **OSCR Lead ID** and **Set in OSCR** so you can find each record fast.
3. Hit **Mark N synced** to clear the flags in one pass.

That keeps OSCR accurate without re-typing anything from memory.

## What this buys you

- One list to work, instead of OSCR in one tab and a spreadsheet in another.
- The dialer inherits carrier-grade compliance instead of hand-rolled DNC.
- OSCR's `appointment score` and `lead source` feed the CRM's priority engine, so the queue ranks on OSCR's own scoring plus IEP timing and freshness.
- Source ROI finally spans OSCR lead sources (Direct Mail File, GLIA EBD Annuity, T65 Prime Web Lead, etc.), so you can see which OSCR filters are actually worth calling.

## Fields added to the CRM

`oscr_lead_id` (unique key), `oscr_lead_source`, `oscr_status`, `oscr_latest_disp`, `oscr_last_disp_date`, `oscr_score`, `oscr_owner`, `callable`, `sms_consent`, `email_consent`, `oscr_synced_at`, `needs_oscr_writeback`, `oscr_writeback_note`.

Header normalization lives in `src/lib/oscrMap.ts`, ported from `C:\dialer\lead_intake\oscr_map.py` so both systems agree on what a column means.

## Still open

- The local `lead_intake` SQLite engine still holds the cadence rules and its own copy. Worth deciding whether that retires into the CRM or stays as the compliance-gate reference.
- Annuity/GLIA and the other never-exported OSCR filters aren't in the CRM yet — export them once and they'll flow in.
