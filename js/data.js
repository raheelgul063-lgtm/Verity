/* Data layer: Supabase (auth, database, storage, edge functions) + the in-browser engine. */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import * as E from "./engine.js";

export const SUPABASE_URL = "https://btyeujbewductabgbqhb.supabase.co";
export const SUPABASE_KEY = "sb_publishable_7g9WNzoP2Z71dgoYwlDr1Q_w3rRrS-I";
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const BUCKET = "documents";
const MAX_MB = 25;

export class AppError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
const check = ({ data, error }) => { if (error) throw new AppError(error.message, error.status || error.code); return data; };

/* ---------- auth ---------- */
export async function session() { return (await sb.auth.getSession()).data.session; }
export async function signUp(email, password) {
  const r = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
  return { needsConfirm: !r.session };
}
export async function signIn(email, password) { check(await sb.auth.signInWithPassword({ email, password })); }
export async function signInGoogle() { check(await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } })); }
export async function signOut() { await sb.auth.signOut(); }
export async function me() {
  const s = await session();
  if (!s) return null;
  const p = check(await sb.from("profiles").select("*").eq("id", s.user.id).maybeSingle());
  return { id: s.user.id, email: s.user.email, credits: p?.credits ?? 0, consent_external_ai: !!p?.consent_external_ai,
    full_name: p?.full_name || "", university: p?.university || "", study_level: p?.study_level || "", country: p?.country || "",
    plan: p?.plan || "free", created_at: p?.created_at || s.user.created_at };
}
export async function giveConsent() { check(await sb.rpc("give_consent")); }
export async function updateProfile(f) {
  check(await sb.rpc("update_profile", { p_full_name: f.full_name, p_university: f.university, p_study_level: f.study_level, p_country: f.country }));
  return true;
}
export async function changePassword(pw) { check(await sb.auth.updateUser({ password: pw })); return true; }
export async function usage() { return check(await sb.from("usage_records").select("*").order("created_at", { ascending: false }).limit(50)); }

/* Pasted text becomes a minimal, valid Word document so the same scan and fix tools work on it. */
export async function textToDocx(title, text) {
  const x = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const para = (t, heading) => `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}<w:r>${heading ? "<w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr>" : ""}<w:t xml:space="preserve">${x(t)}</w:t></w:r></w:p>`;
  const paras = text.replace(/\r/g, "").split(/\n{2,}|\n/).map((t) => t.trim()).filter(Boolean);
  const body = para(title, true) + paras.map((t) => para(t)).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file("word/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr></w:style></w:styles>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  const blob = await zip.generateAsync({ type: "blob", mimeType: MIME.docx, compression: "DEFLATE" });
  const safe = title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "Pasted text";
  return new File([blob], `${safe}.docx`, { type: MIME.docx });
}

/* ---------- edge functions ---------- */
async function fn(name, body) {
  const s = await session();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${s ? s.access_token : SUPABASE_KEY}` },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new AppError((data && (data.error || data.message)) || `Request failed (${r.status})`, r.status);
  return data;
}
export async function status() {
  try { return await fn("scan", { action: "status" }); }
  catch { return { copyleaks: "sample", claude: "sample", claude_model: null, unreachable: true }; }
}

/* ---------- files ---------- */
const blobCache = new Map();
export async function versionBlob(v) {
  if (blobCache.has(v.id)) return blobCache.get(v.id);
  const data = check(await sb.storage.from(BUCKET).download(v.storage_path));
  const buf = new Uint8Array(await data.arrayBuffer());
  blobCache.set(v.id, buf);
  return buf;
}
async function sha256(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const MIME = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

async function createVersion(doc, buf, parent, note) {
  const { elements, stats } = await E.analyse(buf);
  const { data: last } = await sb.from("versions").select("number").eq("document_id", doc.id).order("number", { ascending: false }).limit(1);
  const number = (last?.[0]?.number || 0) + 1;
  const path = `${doc.user_id}/${doc.id}/v${number}.${doc.format}`;
  check(await sb.storage.from(BUCKET).upload(path, new Blob([buf], { type: MIME[doc.format] }), { upsert: false, contentType: MIME[doc.format] }));
  const v = check(await sb.from("versions").insert({ document_id: doc.id, number, storage_path: path, sha256: await sha256(buf),
    parent_version_id: parent ? parent.id : null, elements, stats, note }).select("*").single());
  check(await sb.from("documents").update({ current_version_id: v.id }).eq("id", doc.id));
  blobCache.set(v.id, buf);
  return v;
}

export async function upload(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") throw new AppError("PDF editing is not in the MVP yet. Save the PDF as DOCX (Word: File > Open > Save as .docx) and upload that.");
  if (!["docx", "pptx"].includes(ext)) throw new AppError("Upload a .docx or .pptx file.");
  if (file.size > MAX_MB * 1024 * 1024) throw new AppError(`File is larger than ${MAX_MB} MB.`);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new AppError("This is not a valid Office file. It may be corrupted or password protected.");
  let a;
  try { a = await E.analyse(buf); } catch (e) { throw new AppError(e.message || "Could not read this file."); }
  if (a.fmt !== ext) throw new AppError(`File content is ${a.fmt.toUpperCase()} but the name ends in .${ext}.`);
  const s = await session();
  const doc = check(await sb.from("documents").insert({ user_id: s.user.id, name: file.name, format: ext }).select("*").single());
  try { await createVersion(doc, buf, null, "Original upload"); }
  catch (e) { await sb.from("documents").delete().eq("id", doc.id); throw e; }
  return doc;
}

export async function listDocs() {
  const docs = check(await sb.from("documents").select("*").is("deleted_at", null).order("created_at", { ascending: false }));
  if (!docs.length) return [];
  const vids = docs.map((d) => d.current_version_id).filter(Boolean);
  const versions = check(await sb.from("versions").select("id, number, stats").in("id", vids));
  const docScans = check(await sb.from("scans").select("id, kind, status, mode, summary, document_id, created_at").in("document_id", docs.map((d) => d.id)).eq("status", "done").order("created_at", { ascending: false }));
  const valid = new Set();
  const seen = new Set();
  const scores = {};
  for (const sc of docScans) {
    const k = sc.document_id + sc.kind;
    if (seen.has(k)) continue;
    seen.add(k); valid.add(sc.id);
    const sm = sc.summary || {};
    const v = sc.mode === "sample" ? "sample" : sc.kind === "ai" ? (sm.ai_share != null ? sm.ai_share * 100 : null) : (sm.aggregated ?? ((sm.identical || 0) + (sm.minor_changes || 0) + (sm.paraphrased || 0)));
    (scores[sc.document_id] = scores[sc.document_id] || {})[sc.kind] = v;
  }
  const findings = check(await sb.from("findings").select("version_id, scan_id").in("version_id", vids).eq("state", "open")).filter((f) => valid.has(f.scan_id));
  const vm = Object.fromEntries(versions.map((v) => [v.id, v]));
  return docs.filter((d) => vm[d.current_version_id]).map((d) => ({ ...d, version: vm[d.current_version_id].number, stats: vm[d.current_version_id].stats,
    open_findings: findings.filter((f) => f.version_id === d.current_version_id).length,
    ai: scores[d.id]?.ai, sim: scores[d.id]?.plagiarism, scanned: !!scores[d.id] }));
}

export async function deleteDoc(docId) {
  const doc = check(await sb.from("documents").select("*").eq("id", docId).single());
  const vs = check(await sb.from("versions").select("storage_path").eq("document_id", docId));
  if (vs.length) await sb.storage.from(BUCKET).remove(vs.map((v) => v.storage_path));
  check(await sb.from("documents").delete().eq("id", doc.id));
}

export async function download(doc, version) {
  const buf = await versionBlob(version);
  const stem = doc.name.replace(/\.(docx|pptx)$/i, "");
  const name = version.number === 1 ? doc.name : `${stem} (Verity v${version.number}).${doc.format}`;
  const url = URL.createObjectURL(new Blob([buf], { type: MIME[doc.format] }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- report ---------- */
const normF = (f) => ({ ...f, start: f.start_pos, end: f.end_pos });
const normE = (e) => ({ ...e, start: e.start_pos, end: e.end_pos, before: e.before_text, after: e.after_text });
export async function report(docId) {
  const doc = check(await sb.from("documents").select("*").eq("id", docId).is("deleted_at", null).maybeSingle());
  if (!doc) throw new AppError("Document not found.", 404);
  const versions = check(await sb.from("versions").select("id, number, note, created_at, sha256, storage_path, stats").eq("document_id", docId).order("number"));
  const version = check(await sb.from("versions").select("*").eq("id", doc.current_version_id).single());
  const scans = check(await sb.from("scans").select("id, kind, provider, mode, status, message, summary, words, version_id, created_at, finished_at").eq("document_id", docId).order("created_at", { ascending: false }));
  const latest = {};
  for (const s of scans) if (!latest[s.kind]) latest[s.kind] = s;
  // only findings from the latest completed scan of each kind count; older scans (e.g. sample mode) are history
  const latestDone = {};
  for (const sc of scans) if (sc.status === "done" && !latestDone[sc.kind] && sc.mode === latest[sc.kind].mode) latestDone[sc.kind] = sc.id;
  const valid = new Set(Object.values(latestDone));
  const findings = check(await sb.from("findings").select("*").eq("version_id", version.id)).map(normF).filter((f) => valid.has(f.scan_id));
  const scanIds = [...valid];
  const srcs = scanIds.length ? check(await sb.from("sources").select("*").in("scan_id", scanIds)) : [];
  const sm = Object.fromEntries(srcs.map((s) => [s.id, s]));
  const rows = {};
  for (const f of findings) {
    f.source = f.source_id && sm[f.source_id] ? { ...sm[f.source_id], date: sm[f.source_id].publish_date } : null;
    if (f.source) { const r = (rows[f.source_id] = rows[f.source_id] || { id: f.source_id, title: f.source.title, url: f.source.url, matched_words: f.source.matched_words, passages: 0 }); r.passages++; }
  }
  const edits = check(await sb.from("edits").select("*").eq("document_id", docId).order("created_at", { ascending: false }).limit(200)).map(normE);
  return {
    document: doc, version, elements: version.elements, scans: latest, findings,
    sources: Object.values(rows).sort((a, b) => b.matched_words - a.matched_words), edits,
    versions: versions.map((v) => ({ ...v, current: v.id === version.id })),
  };
}

export async function startScan(docId, kinds) { return fn("scan", { action: "start", document_id: docId, kinds }); }
export async function markReviewed(findingId) { check(await sb.from("findings").update({ state: "reviewed", note: "Reviewed by the author." }).eq("id", findingId)); }

/* ---------- fixing ---------- */
export function selectFindings(rep, { finding_ids, scope, level, location }) {
  let items = rep.findings.filter((f) => f.state === "open");
  if (finding_ids?.length) items = items.filter((f) => finding_ids.includes(f.id));
  else if (level === "page") items = items.filter((f) => f.location === location);
  else if (level !== "document") throw new AppError("Choose findings, a page/slide, or the whole document.");
  if (scope === "ai" || scope === "plagiarism") items = items.filter((f) => f.type === scope);
  if (level === "paragraph" && finding_ids?.length) {
    const els = new Set(items.map((f) => f.element_id));
    items = rep.findings.filter((f) => f.state === "open" && els.has(f.element_id) && (scope === "both" || f.type === scope));
  }
  return items;
}
async function currentParts(rep) {
  const buf = await versionBlob(rep.version);
  const pkg = await E.openPackage(buf);
  return { buf, elements: await E.extract(pkg) };
}
function sourceInfo(f) {
  if (!f || f.type !== "plagiarism" || !f.source) return null;
  if (f.source.title?.startsWith("Sample source")) return { title: f.source.title };
  return { title: f.source.title, url: f.source.url, author: f.source.author, publisher: f.source.publisher, date: f.source.publish_date };
}

export async function propose(rep, req, onProgress) {
  const findings = selectFindings(rep, req);
  if (!findings.length) throw new AppError("No open findings match this selection.");
  const { elements } = await currentParts(rep);
  const byId = Object.fromEntries(elements.map((e) => [e.id, e]));
  const groups = new Map();
  for (const f of findings) {
    const key = req.level === "passage" ? `${f.element_id}|${f.id}` : f.element_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = [];
  let n = 0;
  for (const fs of groups.values()) {
    onProgress && onProgress(++n, groups.size);
    const el = byId[fs[0].element_id];
    const start = Math.min(...fs.map((f) => f.start)), end = Math.max(...fs.map((f) => f.end));
    const base = { document_id: rep.document.id, finding_ids: fs.map((f) => f.id), base_version_id: rep.version.id, element_id: fs[0].element_id,
      method: "ai", mode: req.mode, level: req.level };
    if (!el) { out.push(check(await sb.from("edits").insert({ ...base, start_pos: start, end_pos: end, status: "failed", error: "Paragraph not found in this version." }).select("*").single())); continue; }
    let tpl;
    try { tpl = E.templateFor(el, start, end); }
    catch (e) { out.push(check(await sb.from("edits").insert({ ...base, start_pos: start, end_pos: end, status: "failed", error: e.message }).select("*").single())); continue; }
    const plag = fs.find((f) => f.type === "plagiarism");
    const scope = req.scope !== "both" ? req.scope : plag && fs.some((f) => f.type === "ai") ? "both" : fs[0].type;
    const tokens = tpl.tokens.map((t) => ({ id: t.id, kind: t.kind, text: t.text }));
    let res = null, err = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fn("rewrite", { template: tpl.template, tokens, before: tpl.context_before, after: tpl.context_after, scope, mode: req.mode,
          level: req.writing_level, style: req.citation_style, source: sourceInfo(plag), plag_action: req.plag_action, retry_error: err });
        E.checkTokens(tpl, res.rewrite);
        err = "";
        break;
      } catch (e) {
        if (e.status === 428) throw e;
        err = e.message; res = null;
        if (!(e instanceof E.EditError)) break;
      }
    }
    const row = { ...base, start_pos: tpl.start, end_pos: tpl.end, element_hash: tpl.element_hash, before_text: tpl.original, template: tpl.template,
      tokens: tpl.tokens.map((t) => ({ id: t.id, kind: t.kind, text: t.text, seg: t.seg })), scope };
    if (!res) out.push(check(await sb.from("edits").insert({ ...row, status: "failed", error: err }).select("*").single()));
    else out.push(check(await sb.from("edits").insert({ ...row, proposal: res.rewrite, after_text: E.restoreTokens(res.rewrite, tokens), explanation: res.explanation, provider: res.provider, status: "proposed" }).select("*").single()));
  }
  return out.map(normE);
}

export async function manualTemplate(rep, elementId, start, end) {
  const { elements } = await currentParts(rep);
  const el = elements.find((e) => e.id === elementId);
  if (!el) throw new AppError("Paragraph not found.");
  const t = E.templateFor(el, start, end);
  return { ...t, tokens: t.tokens.map((x) => ({ id: x.id, kind: x.kind, text: x.text, seg: x.seg })) };
}
const tplFromEdit = (e) => ({ tokens: e.tokens.map((t) => ({ ...t, seg: t.seg ?? null })) });

export async function createManual(rep, m, newTemplate) {
  E.checkTokens({ tokens: m.tokens }, newTemplate);
  const row = { document_id: rep.document.id, finding_ids: m.finding_ids || [], base_version_id: rep.version.id, element_id: m.element_id,
    start_pos: m.start, end_pos: m.end, element_hash: m.element_hash, before_text: m.original, template: m.template, tokens: m.tokens,
    proposal: newTemplate, after_text: E.restoreTokens(newTemplate, m.tokens), explanation: "Edited by hand.", method: "manual", status: "proposed" };
  return normE(check(await sb.from("edits").insert(row).select("*").single()));
}
export async function updateProposal(edit, text) {
  E.checkTokens(tplFromEdit(edit), text);
  return normE(check(await sb.from("edits").update({ proposal: text, after_text: E.restoreTokens(text, edit.tokens), method: "ai+manual" }).eq("id", edit.id).select("*").single()));
}
export async function reject(ids) { if (ids.length) check(await sb.from("edits").update({ status: "rejected" }).in("id", ids).eq("status", "proposed")); }

export async function applyEdits(docId, ids, onProgress) {
  const out = [];
  let n = 0;
  for (const id of ids) {
    onProgress && onProgress(++n, ids.length);
    const e = normE(check(await sb.from("edits").select("*").eq("id", id).single()));
    if (e.status !== "proposed") { out.push(e); continue; }
    const doc = check(await sb.from("documents").select("*").eq("id", docId).single());
    const base = check(await sb.from("versions").select("*").eq("id", doc.current_version_id).single());
    if (e.after === e.before) { out.push(normE(check(await sb.from("edits").update({ status: "rejected", error: "No change in text, nothing applied." }).eq("id", e.id).select("*").single()))); continue; }
    let res;
    try {
      res = await E.apply(await versionBlob(base), e.element_id, e.start, e.end, e.proposal, e.element_hash);
    } catch (err) {
      out.push(normE(check(await sb.from("edits").update({ status: "failed", error: err.message }).eq("id", e.id).select("*").single())));
      continue;
    }
    const nv = await createVersion(doc, res.data, base, `Edit ${e.method}: ${e.element_id}`);
    await carryFindings(base, nv, e);
    let upd = normE(check(await sb.from("edits").update({ status: "applied", to_version_id: nv.id, base_version_id: base.id, applied_at: new Date().toISOString(), validation: res.report }).eq("id", e.id).select("*").single()));
    const hadAI = e.scope === "ai" || e.scope === "both" || e.method === "manual";
    if (hadAI) {
      let rescan;
      try { rescan = await fn("scan", { action: "rescan", text: e.after }); } catch (err) { rescan = { status: "error", message: err.message }; }
      upd = normE(check(await sb.from("edits").update({ rescan }).eq("id", e.id).select("*").single()));
      await applyRescan(nv, e, rescan);
    }
    out.push(upd);
  }
  return out;
}
async function carryFindings(oldV, newV, e) {
  const old = check(await sb.from("findings").select("*").eq("version_id", oldV.id));
  const texts = Object.fromEntries(newV.elements.map((x) => [x.id, x.text]));
  const rows = old.map((f) => {
    const { id, created_at, ...rest } = f;
    const nf = { ...rest, version_id: newV.id, origin_finding_id: f.origin_finding_id || f.id };
    if (f.element_id === e.element_id && f.state === "open") {
      if (e.finding_ids.includes(f.id) || (f.start_pos < e.end && f.end_pos > e.start)) {
        nf.state = "fixed_pending";
        nf.note = f.type === "ai" ? "Rewritten. Waiting for re-check." : "Rewritten with attribution. Run a plagiarism re-scan to confirm.";
        nf.start_pos = e.start; nf.end_pos = e.start + e.after.length; nf.text = e.after;
        nf.evidence = { ...(f.evidence || {}), replaced_text: f.text, edit_id: e.id };
      } else {
        const idx = (texts[f.element_id] || "").indexOf(f.text);
        if (idx >= 0) { nf.start_pos = idx; nf.end_pos = idx + f.text.length; }
        else { nf.state = "stale"; nf.note = "Paragraph was edited; run a re-scan."; }
      }
    }
    return nf;
  });
  if (rows.length) check(await sb.from("findings").insert(rows));
}
async function applyRescan(v, e, r) {
  const fs = check(await sb.from("findings").select("id, type, evidence, note").eq("version_id", v.id).eq("state", "fixed_pending"));
  for (const f of fs) {
    if (f.evidence?.edit_id !== e.id || f.type !== "ai") continue;
    let upd;
    if (r.status === "done") upd = r.flagged ? { state: "open", note: "Still flagged by the detector after the rewrite. Review it manually." } : { state: "fixed", note: "Re-checked: no longer flagged." };
    else upd = { note: r.message || f.note };
    check(await sb.from("findings").update(upd).eq("id", f.id));
  }
}
export async function undo(docId, editId) {
  const e = check(await sb.from("edits").select("*").eq("id", editId).single());
  const doc = check(await sb.from("documents").select("*").eq("id", docId).single());
  if (e.status !== "applied") throw new AppError("Applied edit not found.");
  if (doc.current_version_id !== e.to_version_id) throw new AppError("Only the most recent edit can be undone. Undo later edits first.");
  check(await sb.from("documents").update({ current_version_id: e.base_version_id }).eq("id", docId));
  return normE(check(await sb.from("edits").update({ status: "undone" }).eq("id", editId).select("*").single()));
}
