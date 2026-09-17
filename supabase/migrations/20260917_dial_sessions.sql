create table if not exists public.dial_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  agent text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'closed')),
  queue jsonb not null default '[]'::jsonb,
  current_index integer not null default 0,
  current_lead_id uuid references public.leads(id),
  phone_command bigint not null default 0,
  phone_state text not null default 'idle' check (phone_state in ('idle', 'dialing', 'ringing', 'connected', 'ended', 'error')),
  phone_event_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists dial_sessions_owner_status_idx
  on public.dial_sessions (owner_id, status, updated_at desc);

alter table public.dial_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'dial_sessions'
      and policyname = 'owners manage dial sessions'
  ) then
    create policy "owners manage dial sessions"
      on public.dial_sessions for all to authenticated
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid());
  end if;
end
$$;
