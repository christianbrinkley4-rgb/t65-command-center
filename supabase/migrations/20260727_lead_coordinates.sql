ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

COMMENT ON COLUMN leads.geocoded_at IS 'When the address was last run through the US Census geocoder. Null = never tried; set with null lat/lng = tried, no match.';
