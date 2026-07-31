import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// telnyx-webhook — Telnyx events land here (telnyx-dial sets webhook_url per call,
// so no portal config). Drives the persistent-line conference and the one-shot
// bridge, and logs each call. verify_jwt is false (Telnyx can't send a Supabase
// JWT); protected by a ?token= shared secret (TELNYX_WEBHOOK_TOKEN).

function dec(s: string | null): Record<string, any> { if (!s) return {}; try { return JSON.parse(atob(s)); } catch { return {}; } }
function b64(o: unknown): string { return btoa(JSON.stringify(o)); }

Deno.serve(async (req: Request) => {
  const token = Deno.env.get("TELNYX_WEBHOOK_TOKEN");
  if (token) { const u = new URL(req.url); if (u.searchParams.get("token") !== token) return new Response("forbidden", { status: 403 }); }

  const KEY = Deno.env.get("TELNYX_API_KEY") || "";
  const CONN = Deno.env.get("TELNYX_CONNECTION_ID") || "";
  const SB = Deno.env.get("SUPABASE_URL");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const H = { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" };
  const telnyx = (path: string, payload: unknown) =>
    fetch(`https://api.telnyx.com/v2${path}`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const patchCall = (id: string, b: unknown) => fetch(`${SB}/rest/v1/calls?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify(b) }).catch(() => {});
  const patchLine = (id: string, b: unknown) => fetch(`${SB}/rest/v1/dial_lines?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify(b) }).catch(() => {});

  let evt: any; try { evt = await req.json(); } catch { return new Response("ok"); }
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
        const r = await telnyx("/conferences", { name: `line-${lineId}-${Date.now()}`, call_control_id: ccid, start_conference_on_create: true });
        const confId = (await r.json())?.data?.id || null;
        if (lineId) await patchLine(lineId, { status: "active", conference_id: confId, telnyx_agent_call_id: ccid });
      } else if (st.leg === "lead-line") {
        if (st.conferenceId) await telnyx(`/conferences/${st.conferenceId}/actions/join`, { call_control_id: ccid });
        if (rowId) await patchCall(rowId, { status: "connected", answered: true, answered_at: new Date().toISOString() });
        if (lineId) await patchLine(lineId, { status: "on_call", current_call_id: rowId || null });
      } else if (st.leg === "agent") {
        await telnyx("/calls", { connection_id: CONN, to: st.leadPhone, from: st.from, timeout_secs: 30, client_state: b64({ callRowId: rowId, leg: "lead", agentCallId: ccid, from: st.from }) });
        if (rowId) await patchCall(rowId, { status: "ringing_lead" });
      } else if (st.leg === "lead") {
        if (st.agentCallId) await telnyx(`/calls/${ccid}/actions/bridge`, { call_control_id: st.agentCallId });
        if (rowId) await patchCall(rowId, { status: "connected", answered: true, answered_at: new Date().toISOString(), telnyx_lead_call_id: ccid });
      }
    } else if (type === "call.hangup") {
      const cause: string = p.hangup_cause || "";
      if (st.leg === "agent-line") {
        if (lineId) await patchLine(lineId, { status: "ended", ended_at: new Date().toISOString() });
      } else if (st.leg === "lead-line") {
        if (rowId) await patchCall(rowId, { status: "completed", ended_at: new Date().toISOString(), disposition: cause || null });
        if (lineId) await patchLine(lineId, { status: "active", current_call_id: null });
      } else if (rowId) {
        await patchCall(rowId, { status: st.leg === "lead" ? "completed" : "ended", ended_at: new Date().toISOString(), disposition: cause || null });
      }
    }
  } catch (_) { /* never fail the webhook */ }

  return new Response("ok", { status: 200 });
});
