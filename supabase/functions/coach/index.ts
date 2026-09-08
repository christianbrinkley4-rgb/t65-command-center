import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// The assistant's voice. Not its judgement.
//
// It receives a brief the app has already finished thinking about: the hour's
// measured reach rate, how many leads are callable, and a ranked shortlist with
// the reason each name is on it. All of that is computed in TypeScript from
// live rows before this function is called. This function writes the sentences.
//
// That split is the whole design. A model asked to rank nine thousand leads by
// counting will do it confidently and wrongly, and the cost of being wrong here
// is somebody's morning. So it is never given the raw book and never asked to
// do arithmetic. If it is unreachable the caller still has the ranked list and
// shows it; only the prose is lost.

const MODEL = "gemini-3.6-flash";

/** Tolerates a secret name with stray whitespace. See smart-capture. */
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

const SYSTEM = `You are the calling coach inside a Medicare insurance CRM used by two agents in Greensboro NC, Christian and Will. They sell to people turning 65.

You will be given a brief containing real numbers from their own book and a ranked shortlist of leads the app has already chosen. Answer the question using ONLY what is in the brief.

Hard rules:
- Never invent a name, a number, a phone number or a statistic. If the brief does not contain it, say you do not have it.
- Never do arithmetic the brief has not already done. The ranking is finished; do not re-order it or second-guess the scores.
- Refer to leads by the names given, in the order given.

Style:
- Talk like a sharp colleague, not a report. Lead with the answer.
- Be brief. Five or six sentences is usually plenty, and a short list of names is better than a paragraph about them.
- Say WHY the top names are the top names, using the reasons in the brief.
- If this hour reaches well below average, say so and say what it means for what they should be doing instead. If it reaches above average, say to get on the phone.
- No em dashes. No bullet-point padding. No "I hope this helps".`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const key = secret("GEMINI_API_KEY");
  if (!key)
    return json({ ok: false, reason: "No GEMINI_API_KEY on this project (stray whitespace in the name was checked for too)." });

  let payload: { brief?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, reason: "bad_request" }, 400);
  }
  const brief = (payload.brief || "").toString().slice(0, 20000);
  if (!brief.trim()) return json({ ok: false, reason: "empty brief" }, 400);

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: brief }] }],
          // Room to think before answering. A tight cap returns an empty
          // candidate with finishReason MAX_TOKENS, which reads as a broken
          // prompt and is not one.
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
        }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return json({
        ok: false,
        reason:
          resp.status === 503
            ? "Gemini is briefly over capacity. The ranked list below is unaffected."
            : `Gemini returned ${resp.status}. ${body.slice(0, 160)}`,
      });
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!text) return json({ ok: false, reason: "Gemini returned an empty answer." });
    return json({ ok: true, answer: text });
  } catch (e) {
    return json({ ok: false, reason: `Could not reach Gemini: ${String(e).slice(0, 160)}` });
  }
});
