# Telephony backend — activation, the spam/answer-rate fix, and cost

> **RETIRED, August 31 2026.** The team calls from personal handsets. The Telnyx
> code was removed from the app in the same change: `lib/telnyx.ts`,
> `lib/agents.ts`, the `telnyx-dial` and `telnyx-webhook` edge functions, the
> call-mode toggle and the line HUD are all gone, and the Dial Session's Call
> button now does one thing, a `tel:` handoff to the handset, still logged.
> Nothing in the app reads this document. It is kept for the reasoning and the
> cost model in case a shared line is ever revisited, which is worth doing
> before a third agent starts: a call returned to a personal cell is invisible
> to the rest of the team. Do not follow the setup steps expecting the app to
> pick the line up. It will not.

Built July 22, 2026. The T65 Command Center can now place real calls through Telnyx from the Dial Session, using a model designed specifically to fix the two problems you had: **low answer rates (spam labeling)** and **cost**.

## What got built

- **`calls` table** in Supabase — one row per call with answer status, timestamps, and duration, so answer rate / talk time / spend are finally measured (see the "Dialer calls" card on Stats).
- **`telnyx-dial` edge function** — a *human-initiated bridge*: it rings YOUR phone first, and only when you pick up does Telnyx dial the lead and connect you. No AMD, no voicemail-drop, no dead air.
- **`telnyx-webhook` edge function** — drives the bridge and logs every call. The Telnyx event webhook is set per-call automatically, so there's no Call Control portal config to do.
- **Dial Session Call button** now calls the bridge (falls back to your device dialer if Telnyx isn't on yet).

## Why your calls were getting marked SPAM (the real cause)

Your old number `+1 336 962 2307` was used for **autodial + answering-machine detection + voicemail drops at volume**. That is the exact fingerprint carriers' spam engines (Hiya, TNS, First Orion) look for. Once a number is flagged, answer rate roughly halves and **does not recover on that number**. Showing a different caller ID doesn't undo it, and spoofing your personal cell isn't allowed — carriers block a `from` number you don't own or haven't verified.

So the fix is two parts, and the app now supports both:

### 1. Change the dialing pattern (done, in code)
The bridge model is a one-to-one, human-paced call — you're live the second the lead answers. That is not a robocall pattern, so a clean number used this way stays clean. This alone is the biggest answer-rate lever.

### 2. Use a clean, *branded* caller ID (your Telnyx setup)
Pick ONE:

- **Best for recognition — show your own cell (`919 408 6671`):** in the Telnyx portal, add your cell as a **Verified Number / outbound caller ID** (Telnyx texts/calls you a code to prove you own it). Then set the secret `TELNYX_CALLER_ID=+19194086671`. Every lead now sees your real number. (To also *receive* on it through Telnyx you'd port it in — optional.)
- **Best for volume — a fresh branded local DID:** buy a new **336** number in Telnyx (your old one is burned), then:
  - Set **CNAM / Caller ID Name** to `Christian Brinkley` or `Bankers Life` so it displays a name, not "Unknown."
  - Register it at **freecallerregistry.com** (free) and confirm **STIR/SHAKEN A-attestation** (Telnyx signs calls from numbers on your account automatically).
  - Consider Telnyx **Branded Calling** (shows your name + reason for call on supported handsets) — the strongest answer-rate boost available.
  - Set `TELNYX_FROM_NUMBERS=+1336XXXXXXX` (comma-separate 2–3 for rotation).

Local presence is automatic: if you load `919` leads and own a `919` DID, the app matches it.

## Your choices (configured)

- **Caller ID leads see:** your existing 336 Telnyx numbers (local presence). Do NOT set `TELNYX_CALLER_ID`; just list your 336 DIDs in `TELNYX_FROM_NUMBERS`. **Do not reuse `+1 336 962 2307`** if it's in the set — it's the burned one. Use only 336 numbers that aren't already spam-flagged, and brand/register them (below).
- **Call flow:** answer-once, stay-on-the-line. You open a line (your phone rings once), then each Call dials a lead into your open line via a Telnyx conference. Lead hangs up, you stay on, dial the next.

## Activate it (one screen, ~2 minutes)

1. **Rotate your keys first** — your Telnyx and Veriphone keys are in plaintext in `C:\dialer\.env` and `C:\dialer\CLAUDE.md`. Generate a new Telnyx API key.
2. Supabase dashboard → **Edge Functions → Manage secrets**, add:
   - `TELNYX_API_KEY` = your new key
   - `TELNYX_CONNECTION_ID` = your Call Control app connection id
   - `TELNYX_FROM_NUMBERS` = your good 336 DID(s), comma-separated (2–3 to rotate)
   - `TELNYX_WEBHOOK_TOKEN` = any random string (protects the webhook)
3. Done — no Telnyx portal webhook setup needed (the app sets it per call).

I don't set these for you on purpose: an API key belongs in the encrypted secret store, never in code or the database.

## Brand the 336 numbers so they stop showing as spam

This is the other half of the answer-rate fix. For each 336 DID you'll dial from:
- Set **CNAM / Caller ID Name** in Telnyx to `Christian Brinkley` or `Bankers Life` so a name shows instead of "Unknown."
- Register it at **freecallerregistry.com** (free, 5 min) and confirm **STIR/SHAKEN A-attestation** (Telnyx signs calls from your numbers automatically).
- Optional but strongest: Telnyx **Branded Calling** (shows your name + reason on supported phones).
- Keep each DID under ~150 calls/day and let the human-paced line pattern do the rest.

## First test call — do NOT test on a real lead

Use two phones you own:
1. In Dial Session, click **Start calling line**. Your phone (`919…`) rings — answer once. The bar should switch to "Line is live."
2. Make a test lead whose phone is your *second* number. Hit **Call**. Your second phone rings showing a 336 number. Answer → you're both on the line.
3. Hang up the second phone — the bar returns to "live," ready for the next. Click **End line** when done.
4. Check the Stats "Dialer calls" card — the call should be logged with answer + duration.

## Cost

The bridge bills only connected minutes — roughly **$0.015/min** for the two legs, so ~$0.02 per 90-second conversation. There's **no always-on server** (the old ngrok/VPS is gone; edge functions are serverless and free at idle). Turn OFF the expensive extras from the old dialer unless you want them: Veriphone scrubbing, Number Lookup ($0.004 each), Deepgram transcription, and call recording. With those off and the bridge model, your telephony spend should drop sharply while answer rate rises.

## What still needs a decision (not built)

- **Two-way SMS** needs A2P 10DLC brand+campaign registration (1–3 days) before it can send.
- **Call recording / live transcription** — your old dialer has this; it's off here by default because it adds cost and you'd opted out. Say the word to wire it in.
