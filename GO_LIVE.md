# Go live — 3 minutes at the desk

Everything is built and deployed. The dialer turns on the moment these secrets exist. I can't paste your API key for you (a key I write into your project is a key that can leak), but every other value is filled in below — copy/paste.

## Step 1 — rotate your Telnyx key (1 min)
Your old key is exposed in plaintext in `C:\dialer\.env` and `C:\dialer\CLAUDE.md`. In the Telnyx portal → **API Keys** → create a new key (and delete the old one). Copy the new key. (Do the same for Veriphone while you're there.)

## Step 2 — secrets in Supabase
Supabase dashboard → **Edge Functions → Manage secrets**.

| Name | Value | Status |
|------|-------|--------|
| `TELNYX_API_KEY` | *(your NEW rotated key)* | done |
| `TELNYX_CONNECTION_ID` | `2962715646867014929` | done |
| `TELNYX_WEBHOOK_TOKEN` | `PnApOF3taMm4n_HUicinO-_rtmHQOJq7` | ADD THIS |
| `TELNYX_FROM_NUMBERS` | *(optional)* | not needed |

**Add `TELNYX_WEBHOOK_TOKEN`** — without it the webhook is open and could be abused to place calls on your account.

**Caller-ID numbers are baked into the dialer:** `+13368401632`, `+13368401445`, `+13362038429` (local presence + rotation). To change later without a redeploy, set `TELNYX_FROM_NUMBERS`.

No Telnyx portal webhook setup — the app points Telnyx at the right place on every call.

## Step 3 — brand the numbers so they don't read as spam (do this week)
For each 336 number, in Telnyx: set **CNAM / Caller ID Name** to `Christian Brinkley` or `Bankers Life`, then register it free at **freecallerregistry.com**. This is the other half of the answer-rate fix.

## Step 4 — first test call (do NOT use a real lead)
1. Open the app → **Dial Session** → **Start calling line**. Your phone (919…) rings — answer once. The bar flips to "Line is live."
2. Make a test lead whose phone is your *second* number. Hit **Call**. That phone rings from a 336 number. Answer → you're both on the line.
3. Hang up the second phone; the bar returns to "live." Click **End line** when done.
4. Check **Stats → Dialer calls** — the call logs with answer + duration.

## Then you're running
Start a line once each session, work the Power List / Dial Session, tap one key per result. Watch the answer-rate number on Stats climb as the branded 336 numbers season. Spend is ~$0.015/min of talk time, no idle server cost.
