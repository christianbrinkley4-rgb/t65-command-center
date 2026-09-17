# T65 SIM Dialer

This is the phone-side companion for the T65 Command Center Dial Session. The
computer owns the filters, ranked queue, notes, dispositions, and next-lead
advance. The Android app watches the shared session and uses the phone's own
cellular SIM through Android's `ACTION_CALL`; it does not use Phone Link,
Telnyx, a VoIP provider, or a second phone number.

## Backend configuration

The app is preconfigured with the existing public Supabase URL and anon key.
It talks directly to the existing Supabase project through Auth and PostgREST:

1. Build and install the app.
2. Sign in with the same email/password used by the web app.
3. Enter the agent name (`Christian` or `Will`) and tap **Sign in**.

The shared computer/phone flow requires applying
`supabase/migrations/20260917_dial_sessions.sql` to the same Supabase project.
Both devices must sign in as the same Supabase user so the session owner's RLS
policy allows the phone to read and update the shared row. Never use a
service-role key in the APK. The email and agent name are stored only in local
app preferences; clear app data to remove them.

## Build and install

From this directory with Android Studio and the Android SDK installed:

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On Windows, use `gradlew.bat` instead of `./gradlew`.

Open the app and sign in. On the computer, open **Dial Session**, choose the
filters, and start the session. The phone then displays the current computer
session and places each call. Grant **Phone** and **Phone state** permission
when Android prompts for the first call. Disposition and advance from the
computer; the phone automatically follows the next current lead.

## Permissions and call behavior

- `CALL_PHONE` is requested only when the first call is started.
- `READ_PHONE_STATE` lets the app observe ringing/off-hook/idle transitions so
  disposition appears after the call ends.
- The app only starts the next call after a disposition is saved. Network
  writes run off the main thread and failures leave the disposition visible so
  it can be retried.
- The queue excludes closed, DNC, appointment-upcoming, needs-info, and
  numberless leads, and prioritizes due work similarly to the web dialer.

Android and carrier behavior can vary. The device must have an active SIM and
cellular service. A default dialer app is **not** required for `ACTION_CALL`,
but the system Phone app and carrier may still show their own confirmation or
call UI. Multi-SIM devices may prompt for which SIM to use; select the SIM
whose number is configured with the carrier. The app does not read or embed
the SIM number.

Calls should be made only during lawful calling hours and in compliance with
your applicable consent and do-not-call obligations.
