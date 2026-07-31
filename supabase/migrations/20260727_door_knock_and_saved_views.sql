ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS do_not_knock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_knock_date date,
  ADD COLUMN IF NOT EXISTS knock_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN leads.do_not_knock IS 'Resident asked us not to come back, or property is inaccessible. Independent of do_not_call — phone-DNC leads are often the best door-knock targets.';

CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  page text NOT NULL DEFAULT 'list',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read saved_views" ON saved_views FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated write saved_views" ON saved_views FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "authenticated update saved_views" ON saved_views FOR UPDATE TO authenticated USING (true);
CREATE POLICY "authenticated delete saved_views" ON saved_views FOR DELETE TO authenticated USING (true);
