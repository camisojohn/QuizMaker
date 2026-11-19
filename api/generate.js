// Save as: /api/generate.js in your Vercel project
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel" });

  const { text = "", types = [], count = 10 } = req.body || {};
  const n = Math.max(5, Math.min(50, Number(count) || 10));

  const src = String(text).replace(/Click to edit Master title style/gi, " ").slice(0, 15000);

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
1. Completely ignore and strip out all PowerPoint template artifacts, including "Click to edit Master title style", slide numbers (e.g., numbers like "18", "21 -"), footers, and headers.
2. Fix all broken or spaced-out text caused by PDF/slide extraction (e.g., "M a r v i n C ." must become "Marvin C.", "angousesmiddleware" must become "Django uses middleware").
3. Only test real, meaningful academic concepts stated in the text. Never ask about slide layouts, UI elements, or template text.
4. Make wrong options plausible, not random. Make answers unambiguous. For true/false and mtf, mix true and false.

Return ONLY a JSON array, no markdown.\n${spec}`;

  const user = `Allowed types: ${types.join(", ")}. Write exactly ${n} questions, cycling through the allowed types evenly.\n\nMATERIAL:\n${src}`;

  // Main model first, then a fallback if it stays busy
  const models = [
    process.env.MODEL || "gemini-3.8-flash",
    process.env.FALLBACK_MODEL || "gemini-2.5-flash",
  ];

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
  });

  const t0 = Date.now();
  const BUDGET_MS = 52000; // stay under the 60s Vercel limit
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

  async function callGemini() {
    let lastErr = "API error";
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = BUDGET_MS - (Date.now() - t0);
        if (remaining < 5000) throw new Error(lastErr === "API error" ? "The AI took too long. Please try again." : lastErr);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(28000, remaining));
        try {
          const body = JSON.parse(payload);
          // Turn off "thinking" on 2.5 models so replies are much faster
          if (model.includes("2.5")) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "x-goog-api-key": key },
              body: JSON.stringify(body),
              signal: ctrl.signal,
            }
          );
          const d = await r.json();
          if (r.ok) return d;
          lastErr = d.error?.message || "API error";
          if (![429, 500, 503].includes(r.status)) break;
        } catch (e) {
          lastErr = e.name === "AbortError" ? "The AI was too slow, trying again…" : String(e.message || e);
        } finally {
          clearTimeout(timer);
        }
        await sleep(1000);
      }
    }
    throw new Error(lastErr);
  }

  try {
    const d = await callGemini();
    const raw = (d.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("The AI returned an unexpected format. Please try again.");

    const questions = JSON.parse(raw.slice(start, end + 1));
    res.status(200).json({ questions });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}