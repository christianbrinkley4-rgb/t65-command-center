# Competitive Brief: T65 Command Center v2 vs the CRMs agents actually pay for

Research date: July 20, 2026. Compared against GoHighLevel, VanillaSoft, Close, AgencyBloc, Radiusbob, and Less Annoying CRM, plus a live audit of our own database.

## Executive summary

Our stack costs $0 a month and already does the two things that matter most for a two person shop: shared lead pool with full touch history, and human-executed nurture sequences that respect compliance. What we're missing is the single feature that justifies VanillaSoft's entire existence: the app deciding, every minute of the day, exactly who to contact next. That, plus four leaks the data audit found, is the gap between "tracker" and "the machine tells us what to do." Everything in the fix list below is buildable in our current architecture.

The biggest single finding is not from the competitors. It's from our own database: 272 leads are inside their 7 month Medicare IEP window right now and the app does not know it. No commercial CRM on this list ships a T65 window radar either. Building it makes us better than all of them at the one thing this business is.

## Competitor profiles

**GoHighLevel ($97 to $497/mo plus usage fees).** The all in one agency platform: pipelines, workflow automation, two way SMS and email in a unified inbox, funnels, booking calendars, reputation management. Its real strength is automated multichannel sequences where messages actually send themselves, and conversation history living on the contact. Its weakness for us: built for marketing agencies managing many clients, priced accordingly, and every automated text it sends is a TCPA decision someone else's software is making for you. We already replicated the parts we need (sequences, touch history) minus auto-send, deliberately.

**VanillaSoft (roughly $80 to $120/seat/mo).** The queue based selling pioneer. Reps never pick from a list: the system serves the next best lead based on priority rules, cadence step, and lead age, and the vendor's claim is 24 to 32 dials per hour versus about 8 on list based CRMs. It answers three questions on one screen: who next, what channel, what to say. This is exactly the "every hour of every day our next call is told to us" ask, and it is the one thing we genuinely do not have. Our Today's Queue is still a list to cherry-pick from.

**Close ($9 solo, real features at $99/seat/mo).** Calling first CRM: built in power dialer that auto-advances through Smart Views (saved dynamic filters that work like live queues), multichannel workflow sequences, call recording. The takeaway for us is the pattern of dispositions: one tap on a call outcome logs it, schedules the follow-up, and advances to the next lead without typing.

**AgencyBloc (quote based, insurance AMS).** The post-sale king: policy tracking, carrier commission reconciliation, renewal dates, Medicare specific fields like Scope of Appointment. Not a prospecting tool. The lesson: the money view. It knows premium and commission per client; we currently track "Closed - Sold" as a status with no dollar amount, so the CRM cannot answer "how far to the $6,000 APC goal."

**Radiusbob (about $34 to $78/user/mo).** Budget insurance CRM with lead distribution, a dialer, and Medicare quoting. Nothing it does beats our stack for a two person team except having a dialer.

**Less Annoying CRM ($15/user/mo).** Simplicity benchmark. One pipeline, one daily agenda email. We already exceed it.

## Feature matrix

| Capability | Ours | GHL | VanillaSoft | Close | AgencyBloc |
|---|---|---|---|---|---|
| Cost per month | $0 | $97+ | ~$100/seat | $99/seat | quote |
| Shared 2,729 lead pool, one screen | Yes | Yes | Yes | Yes | Yes |
| Append-only touch history | Yes (built July 20) | Yes | Yes | Yes | Yes |
| Nurture sequences w/ exit conditions | Yes (human executed) | Yes (auto send) | Yes | Yes | Partial |
| Next-best-lead served automatically | **No** | Partial | **Yes, core** | Yes (dialer) | No |
| One-tap call dispositions | **No** | Partial | Yes | Yes | No |
| T65 / IEP birthday radar | **No (data ready)** | No | No | Partial | Partial |
| Appointment tracking + today view | **No (column unused)** | Yes | Yes | Yes | Yes |
| Revenue / APC goal tracking | **No** | Partial | No | Yes | Yes, deepest |
| Activity dashboard (dials/day/person) | **No** | Yes | Yes | Yes | Yes |
| Two way SMS in app | No | Yes | Yes | Yes | Partial |
| Duplicate detection | **No** | Yes | Yes | Yes | Yes |
| Offline-proof, no vendor lock | Yes | No | No | No | No |
| TCPA posture | Human makes every touch | Software sends | Human | Mixed | Human |

## What we have that others do better elsewhere, and where we already win

We win on cost ($0 vs $1,200 to $6,000 a year for two seats), on fit (buckets and sources match exactly how you and Will work), on compliance posture (nothing auto-sends, so no software-initiated TCPA exposure), and on data ownership. Our sequence engine is the equal of GHL's for a human-executed cadence. Nobody on the list has our Christian/Will split with a shared login and per-person activity stamping.

## What they have that we don't, ranked by impact on the end goal

1. **The next-best-lead engine (VanillaSoft's core).** The end goal in one sentence is VanillaSoft's product. We have all the ingredients: due dates, sequences, tiers, home values, birthdays. Missing is the screen that ranks them into one queue and serves them one at a time.
2. **One-tap dispositions (Close's pattern).** Today logging a call takes opening the drawer, typing a status, picking a date, saving. That's 20 seconds of friction times 60 dials a day. One tap should log the outcome, write history, schedule the retry, and show the next lead.
3. **The money view (AgencyBloc's pattern).** No premium amount on sold policies means the CRM can't show APC progress against the $6,000 personal / $12,000 with match target.
4. **Appointment operations.** `appointment_datetime` exists, is written by nothing, read by nothing. No "what appointments do we have today" view.
5. **Activity accountability (every competitor).** Dials per day per person. We log the data now; we don't show it.
6. **Two way SMS (GHL/Close).** Real gap, but it needs a server and a Telnyx integration, and texting T65 seniors has consent rules. Phase 2, not now.

## Leaks the data audit found in our own system

1. **272 leads are in their IEP window today and nothing surfaces them.** 2,451 of 2,729 leads have birthdays. The IEP is 7 months: 3 before the 65th birthday month, the month, 3 after, and enrolling in the 3 months before the birthday month is when coverage starts cleanest, which means the hottest call window is month minus 4 through minus 1. This is the single highest value untouched asset in the database.
2. **104 leads share 52 phone numbers.** Same person, two source trackers. Risk: Will calls a lead Christian burned yesterday. Needs a dupe flag on the lead and in search.
3. **Zero emails on file.** Every Email step in any sequence is dead weight until emails get captured on first contact. The drawer doesn't even have an email field editable.
4. **Zero appointments recorded in the column built for them.** Appointments live as status text, so they can't be sorted by time or shown as a day plan.
5. **Follow-up note field exists in the database but not in the UI.** You can set a date but can't say why. "Call back Tuesday, wife handles insurance, ask about the Humana letter" currently goes in general notes or nowhere.

## Fix plan (all shipping now unless marked)

1. **Next Up tab**: priority-scored queue serving one lead at a time. Score: overdue and due-today first (oldest first), IEP window boost, tier and home value tiebreak; when the due work is done it feeds never-dialed leads, highest value first, so the queue literally never runs out. Calling-hours guard (8am to 9pm) with a banner outside the window.
2. **One-tap dispositions** on the Next Up card: No Answer (+2d), Voicemail (+3d), Talked - Interested (+3d), Talked - Not Ready (+30d), Appointment Set (picks datetime), Not Interested, Bad Number, DNC (all close), Skip. Every tap writes activity history, updates the lead, advances any active sequence touch, and serves the next lead.
3. **T65 Radar tab**: every lead with a birthday, bucketed by IEP position (pre-window approaching, hot months before birthday, birthday month, post-window closing), sorted by urgency.
4. **Appointments**: settable in the drawer, auto-set status, and a today/tomorrow appointment strip on Today's Queue.
5. **APC tracker**: premium field on sold leads, Stats progress bar against $6,000 / $12,000.
6. **Activity dashboard** on Stats: dials and touches today and this week, Christian vs Will.
7. **Dupe flag**: shared-phone leads marked in rows and drawer.
8. **Drawer fixes**: follow-up note and email editable.
9. Phase 2 (not now): Telnyx two way SMS, call recording, commission reconciliation, email capture automation.

Success metrics: queue serves a next action 100% of working hours (never empty); 272 IEP-window leads each get a logged touch within 14 days; every sold policy carries a premium so APC progress is live; zero double-dials on duplicate numbers.

## Sources

- [VanillaSoft queue-based lead management](https://vanillasoft.com/blog/queue-based-lead-management-benefits), [VanillaSoft platform](https://vanillasoft.com/platform/lead-management), [VanillaSoft review](https://www.sonant.ai/blog/vanillasoft-alternative-review)
- [GoHighLevel pricing 2026](https://www.ruzuku.com/compare/gohighlevel-pricing), [GoHighLevel features](https://www.gohighlevel.ai/blog/gohighlevel-features-list), [GoHighLevel review](https://crmside.com/gohighlevel-review/)
- [Close CRM review](https://eanasir.co/review/close/), [Close CRM smart views and dialer](https://www.authencio.com/blog/close-crm-review-power-dialer-pricing-pros-cons-competitors)
- [AgencyBloc](https://www.agencybloc.com/), [Best insurance CRM comparisons](https://crm.org/crmland/best-insurance-crm), [Medicare CRM guide](https://kundpro.com/learn/best-medicare-crm-ams-insurance-agents/)
- [Medicare IEP window, UnitedHealthcare](https://www.uhc.com/medicare/medicare-education/medicare-initial-enrollment-period.html), [Senior65 IEP explained](https://www.senior65.com/medicare/article/medicare-at-65-the-7-month-initial-enrollment-window-explained)
