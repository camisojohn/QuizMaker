// Vercel serverless function: /api/generate
// Goal: ALWAYS answer with clean JSON before Vercel's own timeout can kill it,
// so the app can fall back to its offline generator instead of showing a crash.

const DEADLINE_MS = Number(process.env.DEADLINE_MS) || 24000; // total time budget for all AI attempts

export default async function handler(req, res) {
  const started = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - started);

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel" });

    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    const text = String(body.text || "");
    const types = Array.isArray(body.types) && body.types.length ? body.types : ["mcq"];
    const n = Math.max(5, Math.min(50, Number(body.count) || 10));
    const src = text.replace(/Click to edit Master title style/gi, " ").slice(0, 8000);

    const spec = `Each question is a JSON object. Fields by "type":
mcq: {type,prompt,options:[4 strings],answer:(exactly one of options)}
tf: {type,prompt:(a full statement),answer:"True"|"False"}
ident: {type,prompt:(a clue/definition, no blanks),answer:(short term)}
enum: {type,prompt:"Enumerate 3 ...",answer:[3 short strings]}
match: {type,prompt,pairs:[{l:term,r:short description} x4]}
fill: {type,prompt:(sentence with ______),answer:(one word/term)}
short: {type,prompt,answer:(model answer, 1-2 sentences),keys:[3-5 keywords]}
prob: {type,prompt:(2-step numeric problem),s1:(number after step 1),answer:(final number)}
scen: {type,scenario,prompt,options:[4 strings],answer:(one of options)}
mtf: {type,prompt:(statement),truth:true|false,answer:(correct word that replaces the wrong one; "" if truth),shown:(the wrong word in the statement; "" if truth)}`;

    const system = `You write professional, clean exam questions from lecture material extracted from presentation slides.

CRITICAL CLEANUP RULES:
1. Completely ignore and strip out all PowerPoint template artifacts, including "Click to edit Master title style", slide numbers, footers, and headers.
2. Fix all broken or spaced-out text caused by PDF/slide extraction (e.g., "M a r v i n C ." must become "Marvin C.").
3. Only test real, meaningful academic concepts stated in the text. Never ask about slide layouts, UI elements, or template text.
4. Make wrong options plausible, not random. Make answers unambiguous. For true/false and mtf, mix true and false.

Return ONLY a JSON array, no markdown.\n${spec}`;

    const user = `Allowed types: ${types.join(", ")}. Write exactly ${n} questions, cycling through the allowed types evenly.\n\nMATERIAL:\n${src}`;

    // Models Google currently serves (gemini-2.0-* was shut down). Tried in order.
    // You can override the first two with MODEL / FALLBACK_MODEL in Vercel (delete them if they name a 2.0 model).
    const models = [
      process.env.MODEL || "gemini-2.5-flash",
      process.env.FALLBACK_MODEL || "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
      "gemini-2.5-flash-lite",
    ].filter((m, i, a) => m && !/2\.0/.test(m) && a.indexOf(m) === i);

    const makePayload = (model, userText) => {
      const generationConfig = { responseMimeType: "application/json", maxOutputTokens: 3000, temperature: 0.6 };
      if (/2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig,
      });
    };

    const parseQuestions = (raw) => {
      raw = raw.replace(/```json|```/g, "").trim();
      const start = raw.indexOf("[");
      if (start === -1) return [];
      const end = raw.lastIndexOf("]");
      if (end > start) { try { const a = JSON.parse(raw.slice(start, end + 1)); if (Array.isArray(a)) return a; } catch {} }
      let cut = raw.lastIndexOf("}");
      while (cut > start) {
        try { const a = JSON.parse(raw.slice(start, cut + 1) + "]"); if (Array.isArray(a)) return a; } catch {}
        cut = raw.lastIndexOf("}", cut - 1);
      }
      return [];
    };

    // One small batch: try each model in turn until one answers
    async function runBatch(typeList) {
      const userText = `Write exactly ${typeList.length} questions, one per type, in this order: ${typeList.join(", ")}.\n\nMATERIAL:\n${src}`;
      for (const model of models) {
        const remaining = left();
        if (remaining < 2500) return { qs: [], err: "time budget used up" };
        try {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "x-goog-api-key": key },
              body: makePayload(model, userText),
              signal: AbortSignal.timeout(Math.min(remaining - 500, 14000)),
            }
          );
          const d = await r.json().catch(() => ({}));
          if (r.ok) {
            const raw = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
            const qs = parseQuestions(raw);
            if (qs.length) return { qs };
          } else {
            var err = d.error?.message || `API error ${r.status}`;
          }
        } catch (e) {
          var err = e.name === "TimeoutError" || e.name === "AbortError" ? "AI took too long" : String(e.message || e);
        }
      }
      return { qs: [], err: typeof err === "string" ? err : "AI unavailable" };
    }

    // Split into batches of 5 and run them all at the same time
    const BATCH = 5;
    const plan = Array.from({ length: n }, (_, i) => types[i % types.length]);
    const batches = [];
    for (let i = 0; i < n; i += BATCH) batches.push(plan.slice(i, i + BATCH));

    const results = await Promise.all(batches.map(runBatch));
    const questions = results.flatMap((r) => r.qs);
    if (questions.length) return res.status(200).json({ questions });

    const lastErr = results.find((r) => r.err)?.err || "AI unavailable";
    return res.status(502).json({ error: lastErr });
  } catch (e) {
    // absolute last resort: still return JSON, never crash
    return res.status(502).json({ error: String(e?.message || e) });
  }
}