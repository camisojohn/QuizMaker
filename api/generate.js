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
    const src = text.replace(/Click to edit Master title style/gi, " ").slice(0, 12000);

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

    // Fast models first. Override in Vercel env vars if you like.
    const models = [
      process.env.MODEL || "gemini-2.5-flash",
      process.env.FALLBACK_MODEL || "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ].filter((m, i, a) => a.indexOf(m) === i);

    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

    const makePayload = (model) => {
      const generationConfig = { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.6 };
      // 2.5 models "think" by default, which is the #1 cause of slow responses. Turn it off.
      if (/2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig,
      });
    };

    // Pull as many complete question objects as possible, even from a truncated reply.
    const parseQuestions = (raw) => {
      raw = raw.replace(/```json|```/g, "").trim();
      const start = raw.indexOf("[");
      if (start === -1) return [];
      const end = raw.lastIndexOf("]");
      if (end > start) {
        try { const a = JSON.parse(raw.slice(start, end + 1)); if (Array.isArray(a)) return a; } catch {}
      }
      // salvage: cut at each "}" from the end until it parses
      let cut = raw.lastIndexOf("}");
      while (cut > start) {
        try { const a = JSON.parse(raw.slice(start, cut + 1) + "]"); if (Array.isArray(a)) return a; } catch {}
        cut = raw.lastIndexOf("}", cut - 1);
      }
      return [];
    };

    let lastErr = "AI unavailable";
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = left();
        if (remaining < 2500) { lastErr = lastErr || "time budget used up"; break; }
        try {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "x-goog-api-key": key },
              body: makePayload(model),
              // never wait past our own budget
              signal: AbortSignal.timeout(Math.min(remaining - 500, 18000)),
            }
          );
          const d = await r.json().catch(() => ({}));
          if (r.ok) {
            const raw = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
            const questions = parseQuestions(raw);
            if (questions.length) return res.status(200).json({ questions, model });
            lastErr = "The AI returned an unexpected format.";
          } else {
            lastErr = d.error?.message || `API error ${r.status}`;
            // only retry on overload / rate limit / server errors; otherwise try the next model
            if (![429, 500, 503].includes(r.status)) break;
          }
        } catch (e) {
          lastErr = e.name === "TimeoutError" || e.name === "AbortError" ? "AI took too long" : String(e.message || e);
        }
        if (left() > 3500) await sleep(600);
      }
    }
    return res.status(502).json({ error: lastErr });
  } catch (e) {
    // absolute last resort: still return JSON, never crash
    return res.status(502).json({ error: String(e?.message || e) });
  }
}