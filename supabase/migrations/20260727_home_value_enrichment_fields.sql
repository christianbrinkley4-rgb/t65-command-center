ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS home_value_source text DEFAULT '',
  ADD COLUMN IF NOT EXISTS home_value_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS home_owner_occupied boolean,
  ADD COLUMN IF NOT EXISTS home_property_type text;

COMMENT ON COLUMN leads.home_value_source IS 'How home_value was set: parcel_match (NC OneMap), tracker_import (T65 Excel tracker at ingest), no_match (checked, nothing found), or blank if never checked.';
COMMENT ON COLUMN leads.home_value_checked_at IS 'When the NC OneMap parcel enrichment last ran for this lead. Null = never checked (distinct from checked-but-no-match).';
