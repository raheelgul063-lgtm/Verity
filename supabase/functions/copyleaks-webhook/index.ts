// Public webhook for Copyleaks: /copyleaks-webhook/{scan_id}/{secret}/status/{STATUS}
//                                /copyleaks-webhook/{scan_id}/{secret}/export/{result/{rid} | crawled | export-completed}
import { admin, cfg, CORS, exportResults, findText, json, Match, storePlagFindings } from "./shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const i = parts.indexOf("copyleaks-webhook");
  const [scanId, secret, kind, a, b] = parts.slice(i + 1);
  const db = admin();
  const { data: scan } = await db.from("scans").select("*").eq("id", scanId).single();
  if (!scan || scan.secret !== secret) return json({ error: "not found" }, 404);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (kind === "status") {
    const status = a;
    if (status !== "completed") {
      await db.from("scan_parts").insert({ scan_id: scan.id, kind: `status_${status}`, body });
      if (status === "error") await db.from("scans").update({ status: "error", message: String(body?.error?.message || JSON.stringify(body)).slice(0, 500), finished_at: new Date().toISOString() }).eq("id", scan.id);
      return json({ ok: true });
    }
    const results = body.results || {};
    const score = results.score || {};
    const total = body.scannedDocument?.totalWords || scan.words || 1;
    const pctOf = (n: number) => Math.round((1000 * (n || 0)) / total) / 10;
    const summary = { identical: pctOf(score.identicalWords), minor_changes: pctOf(score.minorChangedWords), paraphrased: pctOf(score.relatedMeaningWords), aggregated: score.aggregatedScore ?? null, total_words: total };
    const ids: string[] = [];
    const rows: any[] = [];
    for (const origin of ["internet", "database", "batch", "repositories"]) {
      for (const r of results[origin] || []) {
        const md = r.metadata || {};
        rows.push({ scan_id: scan.id, user_id: scan.user_id, provider_result_id: r.id, origin, title: r.title || "", url: r.url || null,
          introduction: r.introduction || "", matched_words: r.matchedWords || 0, publisher: md.organization || "", publish_date: md.publishDate || "", author: md.author || "" });
        ids.push(r.id);
      }
    }
    if (rows.length) await db.from("sources").insert(rows);
    if (!ids.length) {
      await db.from("scans").update({ summary, status: "done", message: "No matching sources found.", finished_at: new Date().toISOString() }).eq("id", scan.id);
      return json({ ok: true });
    }
    try {
      await exportResults(scan.provider_scan_id, `x${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, ids, `${cfg.functionsBase}/copyleaks-webhook/${scan.id}/${scan.secret}/export`);
      await db.from("scans").update({ summary, status: "exporting", message: "Downloading matched passages from Copyleaks." }).eq("id", scan.id);
    } catch (e) {
      await db.from("scans").update({ summary, status: "error", message: String((e as Error).message).slice(0, 500) }).eq("id", scan.id);
    }
    return json({ ok: true });
  }

  if (kind === "export" && (a === "result" || a === "crawled")) {
    await db.from("scan_parts").insert({ scan_id: scan.id, kind: a, rid: a === "result" ? decodeURIComponent(b || "") : null, body });
    return json({ ok: true });
  }

  if (kind === "export" && a === "export-completed") {
    const { data: partsRows } = await db.from("scan_parts").select("kind, rid, body").eq("scan_id", scan.id).in("kind", ["result", "crawled"]);
    const crawled: string = partsRows?.find((p) => p.kind === "crawled")?.body?.text?.value || "";
    const same = !crawled || crawled === scan.scan_text;
    const { data: srcs } = await db.from("sources").select("id, provider_result_id").eq("scan_id", scan.id);
    const srcIds = Object.fromEntries((srcs || []).map((s) => [s.provider_result_id, s.id]));
    const matches: Match[] = [];
    for (const p of partsRows || []) {
      if (p.kind !== "result") continue;
      const srcText: string = p.body?.text?.value || "";
      const comp = p.body?.text?.comparison || {};
      for (const [ptype, label] of [["identical", "identical"], ["minorChanges", "minor_changes"], ["relatedMeaning", "paraphrased"]]) {
        const blk = comp[ptype] || {};
        const sus = blk.suspected?.chars || {}, src = blk.source?.chars || {};
        (sus.starts || []).forEach((s: number, i: number) => {
          const ln = sus.lengths[i];
          const g = same ? [s, s + ln] : findText(scan.scan_text, crawled.slice(s, s + ln), s);
          if (!g) return;
          const ex = src.starts?.[i] !== undefined ? srcText.slice(src.starts[i], src.starts[i] + src.lengths[i]) : "";
          matches.push({ result_id: p.rid, type: label, start: g[0], end: g[1], excerpt: ex });
        });
      }
    }
    await storePlagFindings(db, scan, matches, srcIds);
    await db.from("scans").update({ status: "done", message: "", finished_at: new Date().toISOString() }).eq("id", scan.id);
    return json({ ok: true });
  }
  return json({ error: "unknown webhook" }, 404);
});
