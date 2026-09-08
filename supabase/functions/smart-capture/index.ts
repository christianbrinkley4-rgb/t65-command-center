import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Smart Capture — Gemini-powered natural-language follow-up parser.
// Turns a plain-English note into a structured CapturePlan. When it cannot
// reach the model it says WHY, and the app falls back to its local keyword
// parser and tells you it did.
//
// Turn it on: Supabase dashboard → Edge Functions → Manage secrets →
// add GEMINI_API_KEY = <your Google AI Studio key>. No redeploy needed.
//
// Two things were broken here and either one alone looked like the same thing.
// The project had no GEMINI_API_KEY, so this returned in 98ms without reading
// anything. And the model was pinned to gemini-2.0-flash, which Google has
// since retired: it now answers 404 telling you to move to gemini-3.6-flash.
// So setting the key would have fixed nothing, and the failure would still
// have been invisible, because every one of these paths quietly returned a
// 200 that the client read as "no plan" and swallowed.

// gemini-2.0-flash is retired and answers 404. Keep this in one place so the
// next retirement is a one-line change rather than a silent regression.
const MODEL = "gemini-3.6-flash";

/**
 * Read a secret, forgiving a name that carries stray whitespace.
 *
 * Not defensive programming for its own sake. This project had the key set as
 * "GEMINI_API_KEY " with a trailing space, pasted in through the dashboard,
 * where the field shows no quotes and a trailing space is invisible. The key
 * was present and correct and the feature reported it missing, which is the
 * worst kind of wrong: the error message was true and useless.
 *
 * An exact hit wins. Only if that fails do we scan the env for a name that
 * trims to the one we want.
 */
function secret(name: string): string | undefined {
  const exact = Deno.env.get(name);
  if (exact) return exact;
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (k.trim() === name && v) return v;
  }
  return undefined;
}


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

  const key = secret("GEMINI_API_KEY");
  if (!key) return json({ configured: false, reason: "No GEMINI_API_KEY set on this project (checked for stray whitespace in the name too)." });

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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
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
        // maxOutputTokens is generous on purpose. The plan itself is a couple
        // of hundred tokens, but this model spends tokens thinking before it
        // answers, and a tight cap makes it stop mid-thought and return an
        // empty candidate with finishReason MAX_TOKENS. That reads exactly
        // like a broken prompt and is not one.
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 2048 },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return json({
        configured: false,
        reason:
          resp.status === 503
            ? "Gemini is briefly over capacity. Try again in a moment."
            : `Gemini returned ${resp.status}. ${body.slice(0, 160)}`,
      }, 200);
    }
    const data = await resp.json();
    const text: string = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return json({ configured: false, reason: "Gemini replied but not with JSON." }, 200);
    const plan = JSON.parse(match[0]);
    plan.source = "ai";
    return json(plan);
  } catch (e) {
    return json({ configured: false, reason: `Could not reach Gemini: ${String(e).slice(0, 160)}` }, 200);
  }
});
