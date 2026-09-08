import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// telnyx-webhook — every Telnyx event lands here. telnyx-dial sets webhook_url
// per call, so there is nothing to configure in the Telnyx portal.
//
// It drives three things:
//
//   1. The persistent line. Your phone rings once, you answer, and you are in a
//      conference. Leads get dialed into that conference one at a time. You
//      never hang up and you never dial.
//
//   2. The keypad. DTMF arrives on YOUR leg, but every action it triggers has
//      to happen on the LEAD's leg, and this function is stateless, so the
//      pointer to the live lead call lives on the dial_lines row.
//
//        1  play the pre-recorded voicemail, then hang up and dial the next
//        2  text this lead, stay on the call
//        3  hang up this lead and dial the next
//        0  pause auto-advance (press 0 again to resume)
//
//   3. Auto-advance. When a lead leg ends, the cursor moves and the next lead
//      in the queue gets dialed, without the browser being involved at all.
//      That matters more than it sounds: the tab is on the phone you are
//      currently talking into.
//
// verify_jwt is false (Telnyx cannot send a Supabase JWT); it is protected by a
// ?token= shared secret in TELNYX_WEBHOOK_TOKEN.

function dec(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(atob(s)); } catch { return {}; }
}
function b64(o: unknown): string { return btoa(JSON.stringify(o)); }
function e164(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return p?.startsWith("+") ? p : d ? "+" + d : "";
}

Deno.serve(async (req: Request) => {
  const token = Deno.env.get("TELNYX_WEBHOOK_TOKEN");
  if (token) {
    const u = new URL(req.url);
    if (u.searchParams.get("token") !== token) return new Response("forbidden", { status: 403 });
  }

  const KEY = Deno.env.get("TELNYX_API_KEY") || "";
  const CONN = Deno.env.get("TELNYX_CONNECTION_ID") || "";
  const SMS_FROM = Deno.env.get("TELNYX_SMS_FROM") || "";
  const SB = Deno.env.get("SUPABASE_URL");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const H = { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" };
  const HR = { ...H, Prefer: "return=representation" };

  const telnyx = (path: string, payload: unknown) =>
    fetch(`https://api.telnyx.com/v2${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  const patchCall = (id: string, b: unknown) =>
    fetch(`${SB}/rest/v1/calls?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify(b) }).catch(() => {});
  const patchLine = (id: string, b: unknown) =>
    fetch(`${SB}/rest/v1/dial_lines?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify(b) }).catch(() => {});
  const getLine = async (id: string) => {
    const r = await fetch(`${SB}/rest/v1/dial_lines?id=eq.${id}&select=*`, { headers: H });
    return (await r.json())?.[0] || null;
  };
  const getLead = async (id: string) => {
    const r = await fetch(
      `${SB}/rest/v1/leads?id=eq.${id}&select=id,name,phone,phone2,sms_consent,do_not_call`,
      { headers: H }
    );
    return (await r.json())?.[0] || null;
  };
  const logActivity = (leadId: string, activityType: string, outcome: string, agent: string) =>
    fetch(`${SB}/rest/v1/activity_log`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ lead_id: leadId, activity_type: activityType, outcome, logged_by: agent || "line" }),
    }).catch(() => {});

  /**
   * Dial whoever the cursor points at, skipping anyone who cannot be called.
   *
   * The skip loop matters. A queue built ten minutes ago can contain a lead
   * who has since gone DNC, or whose only number is a note somebody typed
   * into the phone field. Without this the line would dial nothing, get no
   * events back, and sit there looking alive while doing nothing.
   */
  async function dialCursor(line: any): Promise<void> {
    const queue: string[] = line.queue || [];
    let i: number = line.cursor ?? 0;

    while (i < queue.length) {
      const lead = await getLead(queue[i]);
      const phone = e164(lead?.phone || lead?.phone2 || "");
      if (!lead || lead.do_not_call || !phone) { i++; continue; }

      const r = await fetch(`${SB}/rest/v1/calls`, {
        method: "POST",
        headers: HR,
        body: JSON.stringify({
          lead_id: lead.id, agent: line.agent, direction: "outbound",
          from_number: line.from_number, to_number: phone, status: "ringing_lead",
          started_at: new Date().toISOString(),
        }),
      });
      const callRowId = (await r.json())?.[0]?.id || "";

      await telnyx("/calls", {
        connection_id: CONN,
        to: phone,
        from: line.from_number,
        timeout_secs: 30,
        webhook_url: `${SB}/functions/v1/telnyx-webhook${token ? `?token=${token}` : ""}`,
        client_state: b64({
          leg: "lead-line", lineId: line.id, callRowId,
          conferenceId: line.conference_id, leadId: lead.id,
        }),
      });
      await patchLine(line.id, { cursor: i, current_call_id: callRowId || null, status: "dialing" });
      return;
    }

    // Ran off the end of the list. The line stays up: you are still on a call
    // with nobody, which is the correct state for "queue finished, hang up
    // when you're ready" and lets the tab show a finished summary.
    await patchLine(line.id, { cursor: queue.length, status: "queue_done", current_lead_ccid: null });
  }

  /** End the lead leg and move the cursor on. */
  async function advance(line: any): Promise<void> {
    await patchLine(line.id, { current_lead_ccid: null, vm_playing: false, current_call_id: null });
    const next = { ...line, cursor: (line.cursor ?? 0) + 1 };
    if (line.auto_advance === false) {
      await patchLine(line.id, { cursor: next.cursor, status: "paused" });
      return;
    }
    await dialCursor(next);
  }

  let evt: any;
  try { evt = await req.json(); } catch { return new Response("ok"); }
  const data = evt?.data || {};
  const type: string = data.event_type || "";
  const p = data.payload || {};
  const st = dec(p.client_state);
  const ccid: string = p.call_control_id || "";
  const rowId: string = st.callRowId || "";
  const lineId: string = st.lineId || "";

  try {
    if (type === "call.answered") {
      if (st.leg === "agent-line") {
        // Your leg answered. Open the conference you'll sit in all session,
        // then start the queue if one was handed over.
        const r = await telnyx("/conferences", {
          name: `line-${lineId}-${Date.now()}`,
          call_control_id: ccid,
          start_conference_on_create: true,
        });
        const confId = (await r.json())?.data?.id || null;
        await patchLine(lineId, { status: "active", conference_id: confId, telnyx_agent_call_id: ccid });
        const line = await getLine(lineId);
        if (line && (line.queue || []).length) await dialCursor({ ...line, conference_id: confId });
      } else if (st.leg === "lead-line") {
        if (st.conferenceId) await telnyx(`/conferences/${st.conferenceId}/actions/join`, { call_control_id: ccid });
        if (rowId) await patchCall(rowId, { status: "connected", answered: true, answered_at: new Date().toISOString(), telnyx_lead_call_id: ccid });
        // The pointer the keypad needs.
        if (lineId) await patchLine(lineId, { status: "on_call", current_call_id: rowId || null, current_lead_ccid: ccid });
      } else if (st.leg === "agent") {
        // One-shot bridge, kept for the single Call button outside a session.
        await telnyx("/calls", {
          connection_id: CONN, to: st.leadPhone, from: st.from, timeout_secs: 30,
          client_state: b64({ callRowId: rowId, leg: "lead", agentCallId: ccid, from: st.from }),
        });
        if (rowId) await patchCall(rowId, { status: "ringing_lead" });
      } else if (st.leg === "lead") {
        if (st.agentCallId) await telnyx(`/calls/${ccid}/actions/bridge`, { call_control_id: st.agentCallId });
        if (rowId) await patchCall(rowId, { status: "connected", answered: true, answered_at: new Date().toISOString(), telnyx_lead_call_id: ccid });
      }
    } else if (type === "call.dtmf.received" && st.leg === "agent-line") {
      // The keypad. Only your leg is listened to; a lead pressing buttons on
      // their own phone must never drive the session.
      const digit: string = p.digit || "";
      const line = await getLine(lineId);
      if (line) {
        const leadCcid: string = line.current_lead_ccid || "";
        const leadId: string = line.queue?.[line.cursor ?? 0] || "";

        if (digit === "0") {
          await patchLine(lineId, { auto_advance: !line.auto_advance });
        } else if (digit === "1" && leadCcid && line.vm_audio_url) {
          // Play the recording into their voicemail. vm_playing tells the
          // playback.ended handler below that it should hang up and move on.
          await patchLine(lineId, { vm_playing: true });
          await telnyx(`/calls/${leadCcid}/actions/playback_start`, { audio_url: line.vm_audio_url });
          if (leadId) await logActivity(leadId, "Call", "Voicemail Left", line.agent);
        } else if (digit === "2" && leadId) {
          const lead = await getLead(leadId);
          const to = e164(lead?.phone || lead?.phone2 || "");
          if (lead && to && SMS_FROM && lead.sms_consent && !lead.do_not_call) {
            const first = String(lead.name || "").trim().split(/\s+/)[0] || "there";
            await fetch("https://api.telnyx.com/v2/messages", {
              method: "POST",
              headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: SMS_FROM,
                to,
                text: `Hi ${first}, ${line.agent || "Christian"} with Bankers Life in Greensboro — just tried you about your Medicare options for turning 65. Happy to answer anything right here by text. Reply STOP to opt out.`,
              }),
            });
            await logActivity(leadId, "Text", "Text - from the line", line.agent);
          } else if (leadId) {
            // Silent no-ops are how you end up believing a text went out that
            // never did. The trail says why it didn't.
            await logActivity(
              leadId,
              "Text",
              !SMS_FROM ? "Not sent - no SMS number configured" : "Not sent - no texting consent on file",
              line.agent
            );
          }
        } else if (digit === "3" && leadCcid) {
          await telnyx(`/calls/${leadCcid}/actions/hangup`, {});
        }
      }
    } else if (type === "call.playback.ended" && st.leg === "lead-line") {
      // The voicemail finished. Hang up rather than leaving dead air on the
      // machine; the hangup event below does the advancing.
      const line = await getLine(lineId);
      if (line?.vm_playing && ccid) {
        await patchLine(lineId, { vm_playing: false });
        await telnyx(`/calls/${ccid}/actions/hangup`, {});
      }
    } else if (type === "call.hangup") {
      const cause: string = p.hangup_cause || "";
      if (st.leg === "agent-line") {
        // You hung up. The session is over, whatever the queue says.
        await patchLine(lineId, { status: "ended", ended_at: new Date().toISOString(), current_lead_ccid: null });
      } else if (st.leg === "lead-line") {
        if (rowId) await patchCall(rowId, { status: "completed", ended_at: new Date().toISOString(), disposition: cause || null });
        const line = await getLine(lineId);
        // Only advance while the line is actually still up. A lead leg ending
        // because YOU hung up first would otherwise start dialing strangers
        // into a conference nobody is sitting in.
        if (line && line.status !== "ended") await advance(line);
      } else if (rowId) {
        await patchCall(rowId, {
          status: st.leg === "lead" ? "completed" : "ended",
          ended_at: new Date().toISOString(),
          disposition: cause || null,
        });
      }
    }
  } catch (_) {
    /* never fail the webhook: Telnyx retries, and a retry storm is worse than a dropped event */
  }

  return new Response("ok", { status: 200 });
});
