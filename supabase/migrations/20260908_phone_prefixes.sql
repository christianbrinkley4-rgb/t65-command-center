-- Line type, for free, forever.
--
-- The paid scrubs charge per NUMBER. But whether a number is a cell or a
-- landline is a property of the six-digit BLOCK it was issued from, not of the
-- number itself, and that assignment is public record. 5,952 callable numbers
-- in this book come from 1,785 distinct prefixes, so the whole thing can be
-- typed with 1,785 free lookups instead of 5,952 paid ones. Cache them here and
-- the second pass, and every future import, costs nothing at all.
--
-- Source is localcallingguide.com's public prefix service, which returns the
-- carrier that owns each block and a company-type letter:
--
--   W  wireless          -> mobile
--   I  incumbent telco   -> fixed_line
--   C  competitive local -> unknown, deliberately
--
-- C is left unknown on purpose. CLEC blocks hold both ported cells and ported
-- landlines and there is no way to tell from the block alone. Checked against
-- 149 numbers that had been typed by a paid vendor: excluding C, this agrees
-- 124 times out of 130, which is 95%. Including C it drops to 83%, and every
-- one of those extra misses is a C. So C stays unknown rather than being
-- guessed at, and it is only 13% of the book.
--
-- WHAT THIS DOES NOT DO
--
-- It does not tell you a line is dead. Only a switch query does that, and
-- RealPhoneValidation wanted $0.019 a number, which is $82 for the leads
-- turning 65 next year. The arithmetic says don't: dead numbers in this book
-- are 88% landline while the book is 38% landline, which works out at roughly
-- 63% of landlines being dead against 5% of mobiles. Simply calling the
-- mobiles first takes the wasted-dial rate from 27% to about 5% for nothing.
-- The last five points are what the $82 buys.

create table if not exists public.phone_prefixes (
  npa char(3) not null,
  nxx char(3) not null,
  -- W / I / C, verbatim from the source, so a future reading of the data
  -- doesn't have to trust this file's interpretation of it.
  company_type text,
  company_name text,
  -- mobile | fixed_line | unknown
  line_type text,
  fetched_at timestamptz not null default now(),
  primary key (npa, nxx)
);

comment on table public.phone_prefixes is
  'Public NPA-NXX block assignments, cached. One row per six-digit prefix, reused across every lead that shares it and every future import.';

alter table public.phone_prefixes enable row level security;

-- Same shape as the rest of the book: signed-in team members read and write,
-- nobody else sees anything. This is public reference data, but the table sits
-- in a database whose default is deny.
drop policy if exists phone_prefixes_rw on public.phone_prefixes;
create policy phone_prefixes_rw on public.phone_prefixes
  for all to authenticated using (true) with check (true);
