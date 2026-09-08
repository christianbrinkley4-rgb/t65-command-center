-- Every question put to the assistant, and the leads it named.
--
-- This table is the reason the assistant can honestly be said to improve. A
-- language model does not learn from being asked; there is no weight update at
-- the end of a conversation. What CAN improve is a system that (a) recomputes
-- its numbers from live data on every ask, which lib/coach.ts does, and (b)
-- keeps a record of what it advised so the advice can be scored against what
-- happened next. Without (b) "is it getting better" has no answer.
--
-- The join that makes it worth having: take recommended_lead_ids from a row,
-- look for activity_log entries against those leads in the hours after
-- asked_at, and compare their reach and appointment rate with the leads worked
-- that day that it did NOT name. If the recommended ones do not do better,
-- the ranking weights in coach.ts are wrong and there is now evidence saying
-- so rather than an argument about it.

create table if not exists public.assistant_asks (
  id uuid primary key default gen_random_uuid(),
  asked_at timestamptz not null default now(),
  asked_by text,
  question text not null,
  answer text,
  -- Stored rather than derived from asked_at, so a later join doesn't have to
  -- re-guess which timezone the agent was standing in.
  local_hour int,
  -- What this hour was worth when the question was asked. Keeping it makes the
  -- recommendation reproducible after the underlying rate has moved on.
  hour_factor numeric,
  -- The leads it named, in the order it named them.
  recommended_lead_ids uuid[] not null default '{}',
  candidate_count int,
  source text
);

comment on table public.assistant_asks is
  'Every question put to the assistant and the leads it named, so recommendations can be joined against what actually happened afterwards. The learning loop lives here, not in a model.';

create index if not exists assistant_asks_asked_at_idx on public.assistant_asks (asked_at desc);

alter table public.assistant_asks enable row level security;
drop policy if exists assistant_asks_rw on public.assistant_asks;
create policy assistant_asks_rw on public.assistant_asks
  for all to authenticated using (true) with check (true);
