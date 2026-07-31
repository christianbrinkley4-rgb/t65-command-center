# CRM platform decision

Reviewed July 20, 2026. The downloaded repositories are useful references, but none should replace or be merged into the T65 Command Center wholesale. The current app is intentionally a focused, two-person system of record: it knows the lead source, latest outcome, activity history, and exactly what Christian or Will should do next.

## Chosen architecture

```text
T65 Command Center (Next.js + Supabase)
  ├─ System of record: leads, activity history, appointments, lead actions
  ├─ Daily work surface: Next Up + Today's action timeline
  ├─ Human-operated contact: calls, texts, emails, mail, and door knocks
  └─ Optional integration boundary: n8n webhooks / scheduled workflows
       ├─ Import and normalize new lead files
       ├─ Morning task digest / exception alerts
       └─ Calendar or inbox sync when deliberately enabled
```

No integration may send consumer messages automatically. The CRM may remind a person to send a text or make a call; the person performs the action and logs the outcome.

## Decisions from the downloaded repositories

| Repository | Decision | Why |
| --- | --- | --- |
| `n8n` | Adopt later as a separate automation service | It is the right workflow layer for file intake, daily summaries, calendar sync, and human-approved workflows. It is not embedded in the Next.js app. |
| `cal.diy` | Keep as a future booking-link option | It can provide a self-hosted calendar link if prospects should book themselves. CRM appointment data remains the source of truth. |
| `chatwoot` | Keep as a future shared-inbox option | Useful only if inbound SMS/email/social messages become large enough to need one inbox. It should not replace the lead queue or automatically reply. |
| `SaaS-Boilerplate` | Borrow quality practices, not the application | Its MIT test, error-reporting, and role-pattern ideas are useful, but its Clerk/Drizzle architecture conflicts with the existing Supabase static app. |
| `open-saas` | Do not integrate | It is a full Wasp/Prisma application. Migrating would delay the CRM without improving the daily two-person workflow. |
| `Relaticle` | Do not copy or embed | It is an entire Laravel CRM under AGPL-3.0. Its agent-native and task-first ideas are adopted conceptually without taking its code. |
| `Twenty` | Do not copy or embed | It is a large AGPL CRM with a separate database, backend, worker, and infrastructure footprint. Its activity/calendar patterns inform the T65 action timeline. |

## What is now in the T65 CRM

- A lead can have multiple independent next actions, each with channel, exact due time, and note.
- The earliest pending action drives the priority queue; an action timeline makes today’s calls, texts, mailers, and door knocks visible in time order.
- Closing, DNC, sale, and appointment outcomes cancel pending actions so stale reminders never stay in the queue.
- Source-specific sequences remain optional templates. The normal work pattern is to record the actual outcome and schedule the actual next actions.

## Next integrations only when needed

1. **n8n intake workflow:** an agent or shared upload drops in a CSV/XLSX file, validates/map fields, checks duplicate phones, and creates CRM leads with a confirmed source label.
2. **Morning digest:** notify Christian and Will of overdue actions, appointments, and unworked new leads. This is a reminder, not a contact workflow.
3. **Calendar bridge:** create or update a calendar event only after an appointment is set in the CRM.
4. **Shared inbox:** evaluate Chatwoot only after a real volume of inbound conversations justifies operating another service.

Each integration should be independently hosted and use the CRM API/database through narrowly scoped credentials. None should fork or merge an external CRM into this repository.
