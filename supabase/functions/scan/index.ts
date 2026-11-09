// POST /scan  { action: "status" | "start" | "rescan", document_id?, kinds?, text? }
// verify_jwt is off so the public "status" action works; every other action checks the user token itself.
import { admin, AI_CHUNK, buildScanText, cfg, chunks, claudeMode, copyleaksMode, CORS, detectAI, json, locate,
  samplePlagiarism, storePlagFindings, submitPlagiarism, userFrom } from "./shared.ts";
import { winstonAI, winstonEnabled, winstonPlagiarism, WINSTON_AI_MIN } from "./winston.ts";

// Detection provider: Winston AI if its key is set, else Copyleaks, else clearly labelled sample data.
const detector = () => (winstonEnabled() ? { name: "Winston AI", mode: "live" } : copyleaksMode() === "sample" ? { name: "Sample data (no detector key)", mode: "sample" } : { name: "Copyleaks", mode: copyleaksMode() });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = admin();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.action === "status") { const d = detector(); return json({ detector: d.name, detector_mode: d.mode, copyleaks: d.mode, claude: claudeMode(), claude_model: claudeMode() === "live" ? cfg.anthropicModel : null }); }

  const user = await userFrom(req, db);
  if (!user) return json({ error: "Please log in." }, 401);
  const { data: profile } = await db.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) return json({ error: "Profile missing." }, 400);

  if (body.action === "rescan") {
    const text: string = body.text || "";
    const d = detector();
    if (d.mode === "sample") return json({ status: "sample", message: "Sample mode: no real re-check. Add a detector key." });
    const min = winstonEnabled() ? WINSTON_AI_MIN : 255;
    if (text.length < min) return json({ status: "too_short", message: `Passage is too short for a separate AI re-check (${d.name} needs ${min}+ characters). Run a full re-scan.` });
    try {
      const r = winstonEnabled() ? await winstonAI(text) : await detectAI(text, [[0, text]], `re${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`);
      return json({ status: "done", flagged: r.sections.length > 0, ai_share: r.docAI, provider: r.provider, mode: r.mode });
    } catch (e) { return json({ status: "error", message: String((e as Error).message) }); }
  }

  if (body.action !== "start") return json({ error: "Unknown action." }, 400);
  const kinds: string[] = (body.kinds || []).filter((k: string) => k === "ai" || k === "plagiarism");
  if (!kinds.length) return json({ error: "Choose ai and/or plagiarism." }, 400);
  const det = detector();
  const mode = det.mode;
  if (mode !== "sample" && !profile.consent_external_ai) return json({ error: "consent_required" }, 428);

  const { data: doc } = await db.from("documents").select("*").eq("id", body.document_id).eq("user_id", user.id).is("deleted_at", null).single();
  if (!doc) return json({ error: "Document not found." }, 404);
  const { data: version } = await db.from("versions").select("id, elements").eq("id", doc.current_version_id).single();
  const st = buildScanText(version!.elements);
  if (!st.text.trim()) return json({ error: "No text found to scan." }, 422);
  const words = st.text.split(/\s+/).filter(Boolean).length;
  // 1 credit per 250 words for AI detection, 2 for plagiarism (it costs the provider twice as much)
  const perKind: Record<string, number> = { ai: 1, plagiarism: 2 };
  const units = Math.max(1, Math.ceil(words / 250));
  const kindCost = (k: string) => (mode === "live" ? units * perKind[k] : 0);
  const cost = kinds.reduce((n, k) => n + kindCost(k), 0);
  if (cost && profile.credits < cost) return json({ error: `This scan needs ${cost} credits, you have ${profile.credits}.` }, 402);
  if (cost) {
    await db.from("profiles").update({ credits: profile.credits - cost }).eq("id", user.id);
    await db.from("usage_records").insert({ user_id: user.id, provider: det.name, action: "scan:" + kinds.join("+"), words, credits: cost });
  }
  const provider = det.name;
  const { data: scans } = await db.from("scans").insert(kinds.map((kind) => ({
    document_id: doc.id, version_id: version!.id, user_id: user.id, kind, provider, mode, status: "running",
    scan_text: st.text, spans: st.spans, words,
  }))).select("*");

  const els = Object.fromEntries((version!.elements as any[]).map((e) => [e.id, e]));
  const out: any[] = [];
  for (const scan of scans!) {
    if (scan.kind === "ai") {
      try {
        const r = winstonEnabled() ? await winstonAI(st.text) : await detectAI(st.text, chunks(st.text, st.spans, AI_CHUNK), scan.id.replaceAll("-", ""));
        const perEl = new Map<string, any[]>();
        for (const sec of r.sections) {
          for (let [id, a, b] of locate(st.spans, sec.start, sec.length)) {
            const piece = els[id].text.slice(a, b);
            if (!piece.trim()) continue;
            a += piece.length - piece.trimStart().length;
            b -= piece.length - piece.trimEnd().length;
            const phrases: [number, number][] = [];
            for (const [ps, pl] of sec.phrases) for (const [pid, pa, pb] of locate(st.spans, ps, pl)) if (pid === id) phrases.push([pa, pb]);
            if (!perEl.has(id)) perEl.set(id, []);
            perEl.get(id)!.push({ id, a, b, prob: sec.probability, phrases });
          }
        }
        // join neighbouring flagged sentences in the same paragraph into one finding
        const merged = new Map<string, any>();
        for (const [id, list] of perEl) {
          list.sort((x, y) => x.a - y.a);
          let cur: any = null;
          for (const m of list) {
            if (cur && m.a <= cur.b + 3) { cur.b = Math.max(cur.b, m.b); cur.prob = cur.prob == null ? m.prob : Math.max(cur.prob, m.prob ?? 0); cur.phrases.push(...m.phrases); }
            else { if (cur) merged.set(`${id}|${cur.a}`, cur); cur = { ...m, phrases: [...m.phrases] }; }
          }
          if (cur) merged.set(`${id}|${cur.a}`, cur);
        }
        const rows = [...merged.values()].map((m) => ({
          document_id: doc.id, version_id: version!.id, scan_id: scan.id, user_id: user.id, type: "ai", element_id: m.id,
          location: els[m.id].location, start_pos: m.a, end_pos: m.b, text: els[m.id].text.slice(m.a, m.b), score: m.prob,
          evidence: { provider: r.provider, mode: r.mode, model_version: r.model, section_probability: m.prob, ai_logic_phrases: m.phrases, document_ai_share: r.docAI },
        }));
        if (rows.length) await db.from("findings").insert(rows);
        const upd = { status: "done", finished_at: new Date().toISOString(), summary: { ai_share: r.docAI, flagged_sections: rows.length, model_version: r.model }, raw: { responses: r.raw } };
        await db.from("scans").update(upd).eq("id", scan.id);
        out.push({ ...scan, ...upd, raw: undefined });
      } catch (e) {
        const upd = { status: "error", message: String((e as Error).message).slice(0, 500), finished_at: new Date().toISOString() };
        await db.from("scans").update(upd).eq("id", scan.id);
        out.push({ ...scan, ...upd });
      }
    } else if (winstonEnabled()) {
      try {
        const w = await winstonPlagiarism(st.text);
        const srcIds: Record<string, string> = {};
        for (const s of w.sources) {
          const { data: row } = await db.from("sources").insert({ scan_id: scan.id, user_id: user.id, provider_result_id: s.id, title: s.title, url: s.url,
            introduction: s.introduction, matched_words: s.matchedWords, author: s.author || "", publish_date: s.date || "" }).select("id").single();
          srcIds[s.id] = row!.id;
        }
        await storePlagFindings(db, scan, w.matches, srcIds);
        const upd = { status: "done", finished_at: new Date().toISOString(), summary: w.summary, raw: { responses: w.raw }, message: w.sources.length ? "" : "No matching sources found." };
        await db.from("scans").update(upd).eq("id", scan.id);
        out.push({ ...scan, ...upd });
      } catch (e) {
        const upd = { status: "error", message: String((e as Error).message).slice(0, 500), finished_at: new Date().toISOString() };
        await db.from("scans").update(upd).eq("id", scan.id);
        out.push({ ...scan, ...upd });
      }
    } else if (mode === "sample") {
      const data = samplePlagiarism(st.text);
      const srcIds: Record<string, string> = {};
      for (const s of data.sources) {
        const { data: row } = await db.from("sources").insert({ scan_id: scan.id, user_id: user.id, provider_result_id: s.id, title: s.title, url: s.url, introduction: s.introduction, matched_words: s.matchedWords }).select("id").single();
        srcIds[s.id] = row!.id;
      }
      await storePlagFindings(db, scan, data.matches, srcIds);
      const upd = { status: "done", finished_at: new Date().toISOString(), summary: { note: "Sample data" } };
      await db.from("scans").update(upd).eq("id", scan.id);
      out.push({ ...scan, ...upd });
    } else {
      const pid = `v${crypto.randomUUID().replaceAll("-", "").slice(0, 30)}`;
      const hook = `${cfg.functionsBase}/copyleaks-webhook/${scan.id}/${scan.secret}/status/{STATUS}`;
      try {
        await submitPlagiarism(st.text, pid, hook, scan.id);
        const upd = { status: "submitted", provider_scan_id: pid, message: "Waiting for Copyleaks to finish (usually 1 to 5 minutes)." };
        await db.from("scans").update(upd).eq("id", scan.id);
        out.push({ ...scan, ...upd });
      } catch (e) {
        const upd = { status: "error", message: String((e as Error).message).slice(0, 500), finished_at: new Date().toISOString() };
        await db.from("scans").update(upd).eq("id", scan.id);
        out.push({ ...scan, ...upd });
      }
    }
  }
  // refund Verity credits for checks that failed
  const refund = out.filter((x) => x.status === "error").reduce((n, x) => n + kindCost(x.kind), 0);
  if (cost && refund) {
    const { data: p } = await db.from("profiles").select("credits").eq("id", user.id).single();
    await db.from("profiles").update({ credits: (p?.credits ?? 0) + refund }).eq("id", user.id);
    await db.from("usage_records").insert({ user_id: user.id, provider: det.name, action: "refund:failed-scan", words, credits: -refund });
  }
  return json(out.map(({ secret: _s, scan_text: _t, spans: _sp, raw: _r, ...rest }) => rest));
});
