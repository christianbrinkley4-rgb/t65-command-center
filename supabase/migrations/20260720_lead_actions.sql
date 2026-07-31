-- Per-lead, human-executed follow-up actions.
-- This deliberately does not send texts or emails. It only puts the next
-- action in the CRM queue for Christian or Will to perform themselves.

create table if not exists public.lead_actions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  action_type text not null check (action_type in ('Call', 'Text', 'Email', 'Mail', 'Door Knock', 'Other')),
  due_at timestamptz not null,
  note text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  created_by text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by text,
  completion_note text
);

create index if not exists lead_actions_pending_due_idx
  on public.lead_actions (status, due_at);

create index if not exists lead_actions_lead_id_idx
  on public.lead_actions (lead_id);

alter table public.lead_actions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lead_actions' and policyname = 'authenticated users manage lead actions'
  ) then
    create policy "authenticated users manage lead actions"
      on public.lead_actions
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end
$$;
