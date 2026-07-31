-- Medicare-specific compliance fields on leads.
-- do_not_call is a hard suppression: a lead with this flag is removed from every
-- call queue in the app, independent of status (a status edit can't accidentally
-- un-suppress a DNC lead). soa/ptc track the CMS documents an agent must have on
-- file before an MA/PDP sales appointment (Scope of Appointment) and before
-- outreach (Permission to Contact).

alter table public.leads add column if not exists do_not_call boolean not null default false;
alter table public.leads add column if not exists soa_on_file boolean not null default false;
alter table public.leads add column if not exists soa_date date;
alter table public.leads add column if not exists ptc_on_file boolean not null default false;

-- Backfill: leads already dispositioned DNC should carry the hard flag.
update public.leads set do_not_call = true
where do_not_call = false and lower(coalesce(status,'')) like 'closed - dnc%';
