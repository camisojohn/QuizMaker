export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY not set in Vercel" });
  const { text = "", types = [], count = 10 } = req.body || {};
  const n = Math.max(5, Math.min(50, Number(count) || 10));
  const src = String(text).replace(/Click to edit Master title style/gi, " ").slice(0, 60000);

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

  const system = `You write exam questions from lecture material. The text was extracted from slides: ignore page numbers, template filler, and spaced-out letters (rejoin them). Only test real concepts that are stated in the text. Never ask about the instructor, slide layout, or filler. Make wrong options plausible, not random. Make answers unambiguous. For true/false and mtf, mix true and false. Return ONLY a JSON array, no markdown.\n${spec}`;
  const user = `Allowed types: ${types.join(", ")}. Write exactly ${n} questions, cycling through the allowed types evenly.\n\nMATERIAL:\n${src}`;

  try {
    const models = [process.env.MODEL || "gemini-3.8-flash", "gemini-flash-latest"];
    let d, ok = false, err = "";
    for (let i = 0; i < 4 && !ok; i++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i < 2 ? 0 : 1]}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: "minimal" } },
        }),
      });
      d = await r.json();
      if (r.ok) ok = true;
      else { err = d.error?.message || "API error"; await new Promise((s) => setTimeout(s, 2500)); }
    }
    if (!ok) return res.status(502).json({ error: err });
    const raw = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").replace(/```json|```/g, "").trim();
    const questions = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
    res.status(200).json({ questions });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}