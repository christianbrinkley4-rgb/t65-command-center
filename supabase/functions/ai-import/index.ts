import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// AI lead-import parser. Paste ANYTHING — a Word-doc route table, a Nextdoor
// thread, a mailing list, a paragraph of scribbled notes — and it returns
// structured lead rows for the Assistant tab to preview and import.
//
// Provider order: ANTHROPIC_API_KEY (Claude) first, GEMINI_API_KEY fallback,
// else { configured: false } and the client uses its local line parser.
// Add either key: Supabase dashboard → Edge Functions → Manage secrets.
// No redeploy needed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You extract insurance sales leads from messy pasted text for two Medicare agents in Greensboro NC.
The text may be a table pasted from Word, a Nextdoor thread, an email, a list of names and addresses, or free-form notes.
Return ONLY a JSON object: {"leads": [...]} where each lead has these keys (null when unknown):
{
  "name": "First Last",
  "phone": "digits or formatted phone, primary",
  "phone2": "second phone if any",
  "email": null or string,
  "address": "street address only, e.g. 1322 Broholmer Ln",
  "city": null or string,
  "zip": null or 5-digit string,
  "county": null or string,
  "birthday": null or "YYYY-MM-DD" (month-year like "Dec 1961" becomes "1961-12-01"; age alone stays null),
  "notes": null or a short line with anything else useful (DNC mentions, spouse, context),
  "dnc_mentioned": boolean (true if the text says do not call / DNC for this person)
}
Rules: one entry per distinct person; a couple at one address is two leads sharing the address.
Never invent data that is not in the text. Keep notes under 200 characters.
If the text contains no identifiable people, return {"leads": []}.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!anthropicKey && !geminiKey) return json({ configured: false });

  let payload: { text?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const text = (payload.text || "").toString().slice(0, 30000);
  if (!text.trim()) return json({ error: "empty" }, 400);

  try {
    let raw = "";
    if (anthropicKey) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 8000,
          system: SYSTEM,
          messages: [{ role: "user", content: `Extract the leads from this text. Return only the JSON.\n\n"""${text}"""` }],
        }),
      });
      if (!resp.ok) return json({ error: "anthropic_error", status: resp.status }, 200);
      const data = await resp.json();
      raw = (data.content?.[0]?.text || "").trim();
    } else {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: `Extract the leads. Return only the JSON.\n\n"""${text}"""` }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
      });
      if (!resp.ok) return json({ error: "gemini_error", status: resp.status }, 200);
      const data = await resp.json();
      raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return json({ error: "parse_error" }, 200);
    const parsed = JSON.parse(match[0]);
    return json({ leads: Array.isArray(parsed.leads) ? parsed.leads : [], provider: anthropicKey ? "claude" : "gemini" });
  } catch (e) {
    return json({ error: "exception", message: String(e) }, 200);
  }
});
