import { supabase } from "./supabaseClient";
import type { Template } from "./types";

export async function fetchTemplates(): Promise<Template[]> {
  const { data, error } = await supabase.from("templates").select("*").order("category").order("name");
  if (error) throw error;
  return (data || []) as Template[];
}

export async function saveTemplate(t: Partial<Template> & { id?: string }): Promise<void> {
  if (t.id) {
    const { error } = await supabase
      .from("templates")
      .update({ name: t.name, channel: t.channel, category: t.category, body: t.body, updated_at: new Date().toISOString() })
      .eq("id", t.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("templates")
      .insert({ name: t.name, channel: t.channel || "Call", category: t.category || null, body: t.body || "" });
    if (error) throw error;
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase.from("templates").delete().eq("id", id);
  if (error) throw error;
}

// Fill {{first}}, {{me}}, {{city}} etc. from a lead so a script is call-ready.
export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => {
    const key = String(k).toLowerCase().trim();
    return vars[key] ?? `{{${k}}}`;
  });
}
