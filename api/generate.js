export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel" });
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
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.MODEL || "claude-sonnet-5-5", max_tokens: 12000, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: d.error?.message || "API error" });
    const raw = d.content.map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
    const questions = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
    res.status(200).json({ questions });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
