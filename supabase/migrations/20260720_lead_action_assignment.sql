-- Assignment lives on the task, not the lead. All leads are a shared pool
-- (assigned_to = 'Both'); a specific follow-up action can be handed to one
-- person, e.g. "Will, call this T65 lead at 6pm". 'Either' means either agent
-- can take it (the default for a plain follow-up).

alter table public.lead_actions
  add column if not exists assigned_to text not null default 'Either';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lead_actions_assigned_to_check'
  ) then
    alter table public.lead_actions
      add constraint lead_actions_assigned_to_check
      check (assigned_to in ('Either', 'Christian', 'Will'));
  end if;
end
$$;

-- Leads are a shared pool now.
update public.leads set assigned_to = 'Both' where assigned_to is distinct from 'Both';
