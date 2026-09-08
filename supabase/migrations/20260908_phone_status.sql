-- Is the line live, as a fact separate from what kind of line it is.
--
-- phone_type was carrying both jobs for a day and it was wrong to. "mobile"
-- and "disconnected" are answers to different questions, and a number can be
-- a disconnected mobile, which the single column could not say.
--
-- The reason there are now two columns is that we found a service that
-- actually answers the first question. Veriphone and Telnyx both only tell you
-- whether a number block is allocated, which is why 25 numbers this book had
-- already marked dead by dialing them came back "valid" from Veriphone.
-- RealPhoneValidation's Turbo API queries the switch instead of a database and
-- returns connected / disconnected / busy / unreachable, along with the line
-- type, in one request. That is the thing that was being asked for.
--
-- Both columns are advisory. Nothing is deleted and nothing is closed. A
-- disconnected number drops out of the DIAL queue only, and the lead stays
-- fully visible on the Leads tab so a better number can be found for them,
-- because a dead line is not a dead person.

alter table public.leads
  -- connected | disconnected | busy | unreachable | unknown
  add column if not exists phone_status text,
  add column if not exists phone2_status text;

comment on column public.leads.phone_status is
  'Live line status from a switch query: connected, disconnected, busy, unreachable, unknown. Advisory — drops the lead from the dial queue, never closes it.';

create index if not exists leads_phone_status_idx on public.leads (phone_status);
