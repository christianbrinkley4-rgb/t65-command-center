import { supabase } from "@/lib/supabaseClient";
import type { ScoredLead } from "@/lib/priority";

export type DialSession = {
  id: string;
  owner_id: string;
  agent: string;
  status: "active" | "paused" | "completed" | "closed";
  queue: Array<{ id: string; name: string | null; phone: string | null; phone2: string | null }>;
  current_index: number;
  current_lead_id: string | null;
  phone_command: number;
  phone_state: "idle" | "dialing" | "ringing" | "connected" | "ended" | "error";
  phone_event_at: string | null;
  updated_at: string;
};

export async function createDialSession(agent: string, queue: ScoredLead[]) {
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) throw new Error("Sign in before starting a shared dial session.");
  const rows = queue.map((lead) => ({
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    phone2: lead.phone2,
  }));
  const { data, error } = await supabase
    .from("dial_sessions")
    .insert({
      owner_id: user.user.id,
      agent,
      queue: rows,
      current_lead_id: rows[0]?.id || null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as DialSession;
}

export async function updateDialSession(id: string, patch: Partial<DialSession>) {
  const { error } = await supabase.from("dial_sessions").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) throw error;
}

export async function closeDialSession(id: string) {
  await updateDialSession(id, { status: "closed", current_lead_id: null });
}
