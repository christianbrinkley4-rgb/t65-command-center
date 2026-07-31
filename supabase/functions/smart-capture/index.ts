import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Smart Capture — Gemini-powered natural-language follow-up parser.
// Turns a plain-English note into a structured CapturePlan. If GEMINI_API_KEY is
// not set as a project secret, it returns { configured: false } and the app
// falls back to its built-in local parser, so the feature always works.
//
// Turn on real AI: Supabase dashboard → Edge Functions → Manage secrets →
// add GEMINI_API_KEY = <your Google AI Studio key>. No redeploy needed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You are a scheduling assistant for two Medicare insurance agents (Christian and Will).
Given a free-text note about a lead interaction, extract a single structured follow-up plan.
Return ONLY a JSON object with these exact keys:
{
  "channel": one of "Call" | "Text" | "Email" | "Mail" | "Door Knock" | "Other",
  "dueDate": "YYYY-MM-DD" (when to bring the lead back; compute from today's date),
  "dueLabel": short human phrase for the timeframe (e.g. "about a month out"),
  "dateExplicit": boolean (true if the note actually stated a timeframe),
  "assignee": one of "Either" | "Christian" | "Will",
  "intent": one of "follow_up" | "appointment" | "not_interested" | "dnc" | "sold",
  "status": suggested lead status string or null (e.g. "Talked - Not Ready", "Talked - Interested", "Closed - Not Interested", "Closed - DNC", "Closed - Sold", "Appointment Set"),
  "stage": suggested stage bucket or null (e.g. "Worked - Follow Up", "Closed", "Appointment Upcoming"),
  "note": a cleaned one-line version of the note
}
If no timeframe is given, set dateExplicit false and default dueDate to one week from today.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ configured: false });

  let payload: { note?: string; lead?: { birthday?: string | null; name?: string | null }; today?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const note = (payload.note || "").toString().slice(0, 2000);
  if (!note.trim()) return json({ error: "empty" }, 400);
  const today = payload.today || new Date().toISOString().slice(0, 10);
  const birthday = payload.lead?.birthday || "unknown";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [{ text: `Today is ${today}. Lead 65th-birthday date: ${birthday}.\nNote: """${note}"""\nReturn only the JSON.` }],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
    if (!resp.ok) return json({ error: "gemini_error", status: resp.status }, 200);
    const data = await resp.json();
    const text: string = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return json({ error: "parse_error" }, 200);
    const plan = JSON.parse(match[0]);
    plan.source = "ai";
    return json(plan);
  } catch (e) {
    return json({ error: "exception", message: String(e) }, 200);
  }
});
