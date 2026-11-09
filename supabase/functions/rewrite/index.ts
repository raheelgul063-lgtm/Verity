// POST /rewrite  { template, tokens, before, after, scope, mode, level, style, source, plag_action, retry_error }
import { admin, cfg, claudeMode, CORS, json, userFrom } from "./shared.ts";

const MODES: Record<string, string> = {
  clarity: "Improve clarity: shorter sentences where useful, concrete wording, no filler.",
  academic_tone: "Improve academic tone: precise, measured, formal register, no hype or unsupported intensifiers.",
  grammar: "Fix grammar, spelling and punctuation only. Keep wording otherwise as close as possible.",
  simplify: "Simplify complex academic language for readability while keeping technical terms.",
  own_voice: "Rewrite in plain, natural academic prose: direct statements, specific wording, no generic phrasing or stock transitions.",
};
const LEVELS: Record<string, string> = { undergraduate: "undergraduate level", postgraduate: "postgraduate (master's) level", doctoral: "doctoral / research level", professional: "professional report level" };
const SYSTEM = `You revise ONE passage of an academic document. You return JSON only.

Rules you must follow:
1. The passage contains protected items written as ⟦n⟧. Keep every ⟦n⟧ exactly once. Items marked "physical" must stay in the same order. Never add new ⟦n⟧.
2. Keep the meaning, argument, claims and technical terminology. Do not add facts, findings, numbers, examples, quotations or references that are not in the passage or the provided source details.
3. Never remove or weaken a citation. Never invent a citation. Only create a new citation from the source details given to you, and only when the task asks for it.
4. Write in the same language as the passage. Match the surrounding paragraph so the new text fits in.
5. Do not use em dashes or en dashes.
6. Return: {"rewrite": "<new passage>", "explanation": "<one or two sentences on what changed and why>"}`;

function task(b: any) {
  const lines: string[] = [];
  const src = b.source ? JSON.stringify(Object.fromEntries(Object.entries(b.source).filter(([, v]) => v))) : null;
  if (b.scope === "citation") {
    lines.push(`This passage matches an external source but has no citation. Do NOT change any existing word, its order or punctuation. Only insert one in-text citation in ${b.style} style at the end of the sentence that contains the matched words (before its final full stop), built ONLY from these source details: ${src}. If author or year are missing, use the title and 'n.d.'.`);
    return lines.join("\n");
  }
  if ((b.scope === "plagiarism" || b.scope === "both") && src) {
    lines.push(b.plag_action === "quote"
      ? `This passage matches an external source. Turn the matching words into a direct quotation and add an in-text citation in ${b.style} style built ONLY from these source details: ${src}. If author or year are missing, use the title and 'n.d.'.`
      : `This passage matches an external source. Write a genuine paraphrase in your own sentence structure (not word swaps) and add an in-text citation in ${b.style} style built ONLY from these source details: ${src}. If author or year are missing, use the title and 'n.d.'.`);
  }
  if (b.scope === "ai" || b.scope === "both" || !src) lines.push(MODES[b.mode] || MODES.clarity);
  lines.push(`Target writing level: ${LEVELS[b.level] || LEVELS.postgraduate}.`);
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = admin();
  const user = await userFrom(req, db);
  if (!user) return json({ error: "Please log in." }, 401);
  const b = await req.json();
  if (claudeMode() === "sample") {
    return json({ rewrite: b.template, explanation: "Sample mode: no Anthropic API key is set, so the text is returned unchanged. Add ANTHROPIC_API_KEY to get real rewrites.", provider: "Sample rewriter (no Claude key)" });
  }
  const { data: profile } = await db.from("profiles").select("consent_external_ai").eq("id", user.id).single();
  if (!profile?.consent_external_ai) return json({ error: "consent_required" }, 428);
  const physical = new Set(["field", "link", "tab", "break", "format"]);
  const userMsg: Record<string, unknown> = {
    task: task(b), text_before_passage: String(b.before || "").slice(-500), passage: b.template, text_after_passage: String(b.after || "").slice(0, 300),
    protected_items: (b.tokens || []).map((t: any) => ({ token: `⟦${t.id}⟧`, kind: t.kind, text: t.text, physical: physical.has(t.kind) })),
  };
  if (b.retry_error) userMsg.previous_attempt_error = `${b.retry_error} Fix this and keep every protected item.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content: JSON.stringify(userMsg) }] }),
  });
  if (!r.ok) return json({ error: `Claude API error (${r.status}): ${(await r.text()).slice(0, 300)}` }, 502);
  const d = await r.json();
  const text = (d.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const m = text.match(/\{[\s\S]*\}/);
  let out: any;
  try { out = JSON.parse(m ? m[0] : text); } catch { return json({ error: "Claude did not return valid JSON. Try again." }, 502); }
  if (typeof out.rewrite !== "string") return json({ error: "Claude response had no rewrite. Try again." }, 502);
  await db.from("usage_records").insert({ user_id: user.id, provider: "Claude", action: "rewrite", words: String(b.template || "").split(/\s+/).length });
  return json({ rewrite: out.rewrite, explanation: out.explanation || "", provider: `Claude (${cfg.anthropicModel})` });
});
