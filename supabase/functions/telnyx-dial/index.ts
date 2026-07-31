import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// telnyx-dial — human-paced dialer backend. Three actions:
//   start-line : ring the agent once; on answer they sit in a Telnyx conference
//   dial       : dial a lead into the agent's open conference (or one-shot bridge)
//   end-line   : hang up the agent's line
// No AMD, no voicemail-drop, no autodial — the agent clicks each dial. Caller ID
// (what the lead sees) = client callerId -> TELNYX_CALLER_ID -> local-presence pick
// from TELNYX_FROM_NUMBERS. Inert (configured:false) until secrets are set.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function b64(o: unknown): string { return btoa(JSON.stringify(o)); }
function areaCode(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return t.length >= 10 ? t.slice(0, 3) : "";
}
function e164(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return p.startsWith("+") ? p : d ? "+" + d : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

  const KEY = Deno.env.get("TELNYX_API_KEY");
  const CONN = Deno.env.get("TELNYX_CONNECTION_ID");
  if (!KEY || !CONN) return json({ configured: false });

  // Christian's clean 336 pool; TELNYX_FROM_NUMBERS overrides without a redeploy.
  const froms = (Deno.env.get("TELNYX_FROM_NUMBERS") || "+13368401632,+13368401445,+13362038429").split(",").map((x) => x.trim()).filter(Boolean);
  const callerOverride = Deno.env.get("TELNYX_CALLER_ID") ? e164(Deno.env.get("TELNYX_CALLER_ID")!) : "";
  const SB = Deno.env.get("SUPABASE_URL");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = Deno.env.get("TELNYX_WEBHOOK_TOKEN") || "";
  const webhookUrl = `${SB}/functions/v1/telnyx-webhook${token ? `?token=${token}` : ""}`;
  const H = { apikey: SR || "", Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=representation" };
  const telnyx = (path: string, payload: unknown) =>
    fetch(`https://api.telnyx.com/v2${path}`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = body.action || "dial";

  if (action === "start-line") {
    const agentPhone = e164(body.agentPhone || "");
    if (!agentPhone) return json({ error: "missing agentPhone" }, 400);
    const from = callerOverride || froms[0];
    let lineId = "";
    try {
      const r = await fetch(`${SB}/rest/v1/dial_lines`, { method: "POST", headers: H, body: JSON.stringify({ agent: body.agent || null, from_number: from, status: "starting" }) });
      lineId = (await r.json())?.[0]?.id || "";
    } catch (_) { /* proceed */ }
    const resp = await telnyx("/calls", { connection_id: CONN, to: agentPhone, from, from_display_name: "T65 Desk", timeout_secs: 30, webhook_url: webhookUrl, client_state: b64({ lineId, leg: "agent-line" }) });
    if (!resp.ok) return json({ error: "telnyx_error", detail: (await resp.text()).slice(0, 300) }, 200);
    const agentCallId = (await resp.json())?.data?.call_control_id || null;
    if (lineId && agentCallId) await fetch(`${SB}/rest/v1/dial_lines?id=eq.${lineId}`, { method: "PATCH", headers: H, body: JSON.stringify({ telnyx_agent_call_id: agentCallId }) }).catch(() => {});
    return json({ ok: true, lineId });
  }

  if (action === "end-line") {
    const lineId = body.lineId;
    if (lineId) {
      const r = await fetch(`${SB}/rest/v1/dial_lines?id=eq.${lineId}&select=*`, { headers: H });
      const line = (await r.json())?.[0];
      if (line?.telnyx_agent_call_id) await telnyx(`/calls/${line.telnyx_agent_call_id}/actions/hangup`, {}).catch(() => {});
      await fetch(`${SB}/rest/v1/dial_lines?id=eq.${lineId}`, { method: "PATCH", headers: H, body: JSON.stringify({ status: "ended", ended_at: new Date().toISOString() }) }).catch(() => {});
    }
    return json({ ok: true });
  }

  const leadPhone = e164(body.leadPhone || "");
  if (!leadPhone) return json({ error: "missing leadPhone" }, 400);
  const ac = areaCode(leadPhone);
  const from = e164(body.callerId || "") || callerOverride || froms.find((f) => areaCode(f) === ac) || froms[0];

  let callRowId = "";
  try {
    const r = await fetch(`${SB}/rest/v1/calls`, { method: "POST", headers: H, body: JSON.stringify({ lead_id: body.leadId || null, agent: body.agent || null, from_number: from, to_number: leadPhone, status: "ringing_lead" }) });
    callRowId = (await r.json())?.[0]?.id || "";
  } catch (_) { /* proceed */ }

  if (body.lineId) {
    const r = await fetch(`${SB}/rest/v1/dial_lines?id=eq.${body.lineId}&select=*`, { headers: H });
    const line = (await r.json())?.[0];
    if (!line || (line.status !== "active" && line.status !== "on_call")) return json({ ok: false, error: "line_not_ready" });
    const resp = await telnyx("/calls", { connection_id: CONN, to: leadPhone, from, timeout_secs: 30, webhook_url: webhookUrl, client_state: b64({ callRowId, lineId: body.lineId, leg: "lead-line", conferenceId: line.conference_id }) });
    if (!resp.ok) return json({ error: "telnyx_error", detail: (await resp.text()).slice(0, 300) }, 200);
    const leadCallId = (await resp.json())?.data?.call_control_id || null;
    if (callRowId && leadCallId) await fetch(`${SB}/rest/v1/calls?id=eq.${callRowId}`, { method: "PATCH", headers: H, body: JSON.stringify({ telnyx_lead_call_id: leadCallId }) }).catch(() => {});
    return json({ ok: true, callId: callRowId, from });
  }

  const agentPhone = e164(body.agentPhone || "");
  if (!agentPhone) return json({ error: "missing agentPhone" }, 400);
  await fetch(`${SB}/rest/v1/calls?id=eq.${callRowId}`, { method: "PATCH", headers: H, body: JSON.stringify({ status: "ringing_agent" }) }).catch(() => {});
  const resp = await telnyx("/calls", { connection_id: CONN, to: agentPhone, from, from_display_name: "T65 Desk", timeout_secs: 30, webhook_url: webhookUrl, client_state: b64({ callRowId, leadPhone, from, agent: body.agent || null, leg: "agent" }) });
  if (!resp.ok) return json({ error: "telnyx_error", detail: (await resp.text()).slice(0, 300) }, 200);
  const agentCallId = (await resp.json())?.data?.call_control_id || null;
  if (callRowId && agentCallId) await fetch(`${SB}/rest/v1/calls?id=eq.${callRowId}`, { method: "PATCH", headers: H, body: JSON.stringify({ telnyx_agent_call_id: agentCallId }) }).catch(() => {});
  return json({ ok: true, callId: callRowId, from, agentPhone });
});
