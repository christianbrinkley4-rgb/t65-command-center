-- What kind of line each number is, and when we last checked.
--
-- Added because the scrub we set out to build does not work. The theory was
-- that a lookup would tell us which numbers are disconnected, so 514 dials a
-- quarter would stop being spent finding out. It does not: Veriphone returned
-- phone_valid = true for all 25 of the numbers the team had already marked
-- dead by dialing them. Carriers do not publish line status, so nothing you
-- can buy at this price knows a number is dead.
--
-- What the same lookup does know is the line type, and on this book that turns
-- out to separate the pile almost perfectly:
--
--   25 numbers marked Bad Number after a dial   22 landline,  3 mobile
--   25 numbers that produced a real conversation  1 landline, 23 mobile
--   150 never-dialed hot-window leads (base rate) 56 landline, 91 mobile
--
-- Against a book that is 38% landline, dead numbers are 88% landline and
-- conversations are 4% landline. A landline on a bought T65 list is usually a
-- stale broker record on legacy copper (Lumen, Windstream, North State, Surry,
-- Yadkin Valley all show up), not a line someone answers.
--
-- So this is not a suppression column and nothing gets closed off the back of
-- it. It is a sort key: mobiles first, landlines still in the queue behind
-- them. A wrong guess costs a lead a place in line, not its life.

alter table public.leads
  add column if not exists phone_type text,
  add column if not exists phone2_type text,
  add column if not exists phone_type_checked_at timestamptz;

comment on column public.leads.phone_type is
  'Line type of phone from a carrier lookup: mobile, fixed_line, voip, or unknown. Sort key only, never a suppression.';
comment on column public.leads.phone2_type is
  'Line type of phone2, same vocabulary as phone_type.';
comment on column public.leads.phone_type_checked_at is
  'When the lookup last ran for this row, so a re-scrub can skip what it already knows.';

-- The queue reads this on every scoring pass over ~9,000 live leads.
create index if not exists leads_phone_type_idx on public.leads (phone_type);
