import { supabase } from "./supabaseClient";

export type DialResult = {
  configured: boolean;
  ok?: boolean;
  callId?: string;
  from?: string;
  agentPhone?: string;
  lineId?: string;
  error?: string;
};

async function invoke(body: Record<string, unknown>): Promise<DialResult> {
  try {
    const { data, error } = await supabase.functions.invoke("telnyx-dial", { body });
    if (error) return { configured: true, ok: false, error: error.message };
    if (!data || data.configured === false) return { configured: false };
    return { configured: true, ...data };
  } catch (e) {
    return { configured: false, error: e instanceof Error ? e.message : "dial failed" };
  }
}

// Start a persistent line: rings the agent once; on answer they sit in a
// conference and each lead is dialed into it.
export function startLine(opts: { agent: string; agentPhone: string }) {
  return invoke({ action: "start-line", ...opts });
}

export function endLine(lineId: string) {
  return invoke({ action: "end-line", lineId });
}

// Hang up the current lead call, keeping the agent's line open for the next dial.
export function hangupCall(callId: string) {
  return invoke({ action: "hangup-call", callId });
}

// Dial a lead. With lineId → dials into the agent's open line. Without →
// one-shot bridge (rings the agent, then bridges the lead).
export function dialLead(opts: {
  leadId?: string;
  leadPhone: string;
  agent: string;
  lineId?: string;
  agentPhone?: string;
}) {
  return invoke({ action: "dial", ...opts });
}
