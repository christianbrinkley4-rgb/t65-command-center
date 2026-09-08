-- The queue moves to the server, so the line can keep dialing without the tab.
--
-- The Dial Session's queue has always lived in React state: an array of lead
-- ids in a browser tab. That works when a human clicks Call for each one. It
-- cannot work for a line that dials the next person by itself, because the
-- thing deciding "who is next" is now a webhook running in Supabase with no
-- access to your tab, and the tab is on a phone that is currently in your hand
-- being used as a telephone.
--
-- So the ordered queue and the cursor move onto the line row. The browser
-- builds the list, exactly as it does today, and hands it over once at the
-- start. After that the line owns it: the webhook advances the cursor when a
-- call ends, and the tab reads the row to show you where it is. Close the tab
-- mid-session and the line keeps working.

alter table public.dial_lines
  -- Lead ids in dial order. The whole session, handed over at start-line.
  add column if not exists queue uuid[] not null default '{}',
  -- How far in. Points at the lead currently being called, or about to be.
  add column if not exists cursor int not null default 0,
  -- Whether a lead hanging up should dial the next one. Pressing 0 on the
  -- keypad turns this off mid-session when you need a minute to write a note,
  -- and the line stays open while you do.
  add column if not exists auto_advance boolean not null default true,
  -- The lead leg currently up. DTMF arrives on the AGENT leg, but every action
  -- it triggers (play the voicemail, hang up) has to target the LEAD leg, and
  -- the webhook is stateless, so the pointer lives here.
  add column if not exists current_lead_ccid text,
  -- Publicly fetchable audio for the pre-recorded voicemail. Telnyx fetches
  -- this URL itself, so it cannot be a signed or private link.
  add column if not exists vm_audio_url text,
  -- Set while a voicemail is playing, so the playback.ended event knows to
  -- hang up and move on rather than leaving dead air on a machine.
  add column if not exists vm_playing boolean not null default false;

comment on column public.dial_lines.queue is
  'Ordered lead ids for this session. Owned by the line once handed over; the browser does not write it again.';
comment on column public.dial_lines.cursor is
  'Index into queue of the lead being called now.';
comment on column public.dial_lines.current_lead_ccid is
  'Telnyx call_control_id of the live lead leg, so keypad actions can target it.';

-- The webhook looks a line up by the agent leg on every event.
create index if not exists dial_lines_agent_call_idx on public.dial_lines (telnyx_agent_call_id);
