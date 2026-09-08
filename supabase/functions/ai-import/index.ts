import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// AI lead-import parser. Paste ANYTHING — a Word-doc route table, a Nextdoor
// thread, a mailing list, a paragraph of scribbled notes — and it returns
// structured lead rows for the Assistant tab to preview and import.
//
// Provider order: ANTHROPIC_API_KEY (Claude) first, GEMINI_API_KEY fallback,
// else a stated reason and the client uses its local line parser.
// Add either key: Supabase dashboard → Edge Functions → Manage secrets.
//
// Same three faults as smart-capture, and they hid each other the same way:
// no key, then a retired gemini-2.0-flash answering 404, then a key set under
// the name "GEMINI_API_KEY " with a trailing space. Every failure path used to
// return a bare error code the client swallowed, so all three looked identical
// from the outside. Each now comes back with a sentence.

const GEMINI_MODEL = "gemini-3.6-flash";

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

  const anthropicKey = secret("ANTHROPIC_API_KEY");
  const geminiKey = secret("GEMINI_API_KEY");
  if (!anthropicKey && !geminiKey)
    return json({
      configured: false,
      reason: "No ANTHROPIC_API_KEY or GEMINI_API_KEY on this project (stray whitespace in the name was checked for too).",
    });

  let payload: { text?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const text = (payload.text || "").toString().slice(0, 30000);
  if (!text.trim()) return json({ error: "empty" }, 400);

  const failed = (reason: string) => json({ configured: false, reason }, 200);

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
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return failed(`Claude returned ${resp.status}. ${body.slice(0, 160)}`);
      }
      const data = await resp.json();
      raw = (data.content?.[0]?.text || "").trim();
    } else {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: `Extract the leads. Return only the JSON.\n\n"""${text}"""` }] }],
          // Room to think before answering; a tight cap returns an empty
          // candidate with finishReason MAX_TOKENS, which reads as a broken
          // prompt and is not one.
          generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 8192 },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return failed(
          resp.status === 503
            ? "Gemini is briefly over capacity. Try again in a moment."
            : `Gemini returned ${resp.status}. ${body.slice(0, 160)}`
        );
      }
      const data = await resp.json();
      raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return failed("The model replied but not with JSON.");
    const parsed = JSON.parse(match[0]);
    return json({ leads: Array.isArray(parsed.leads) ? parsed.leads : [], provider: anthropicKey ? "claude" : "gemini" });
  } catch (e) {
    return failed(`Could not reach the model: ${String(e).slice(0, 160)}`);
  }
});
