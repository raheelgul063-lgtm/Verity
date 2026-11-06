/* Verity precision engine (browser + Node).
 * Opens a DOCX/PPTX with JSZip, edits text inside the runs of ONE paragraph,
 * copies every other ZIP entry unchanged and proves it before returning the new file.
 * Needs JSZip, DOMParser, XMLSerializer (browser globals, or setEnv() in Node).
 */
export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const env = { JSZip: globalThis.JSZip, DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer, subtle: globalThis.crypto?.subtle };
export function setEnv(e) { Object.assign(env, e); }

export class EditError extends Error {}

const is = (el, ns, local) => el && el.nodeType === 1 && el.namespaceURI === NS[ns] && el.localName === local;
const kids = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 1);
function nearest(node, pred) {
  let c = node.parentNode;
  while (c && c.nodeType === 1) { if (pred(c)) return c; c = c.parentNode; }
  return null;
}
const ser = () => new env.XMLSerializer();
async function sha256(str) {
  const buf = await env.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseXml(str) {
  const doc = new env.DOMParser().parseFromString(str, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new EditError("The file contains damaged XML.");
  return doc;
}
function joinPath(folder, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (folder ? folder.split("/") : []).concat(target.split("/"));
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return out.join("/");
}

/* ---------------- package ---------------- */
export async function openPackage(data) {
  let zip;
  try { zip = await env.JSZip.loadAsync(data); }
  catch { throw new EditError("File is not a valid DOCX/PPTX (not a ZIP package). It may be corrupted or password protected."); }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (names.includes("EncryptedPackage") || names.includes("EncryptionInfo")) throw new EditError("File is password protected. Remove the password and upload again.");
  if (!names.includes("[Content_Types].xml") || !names.includes("_rels/.rels")) throw new EditError("File is not a valid Office document.");
  const rels = parseXml(await zip.file("_rels/.rels").async("string"));
  let main = null;
  for (const r of Array.from(rels.getElementsByTagNameNS(NS.rel, "Relationship"))) if (r.getAttribute("Type") === OFFICE_DOC) main = r.getAttribute("Target").replace(/^\//, "");
  if (!main) throw new EditError("Could not find the main document part.");
  const fmt = main.startsWith("word/") ? "docx" : main.startsWith("ppt/") ? "pptx" : null;
  if (!fmt) throw new EditError("Only DOCX and PPTX are supported.");
  return { zip, fmt, main, names, trees: {} };
}
async function tree(pkg, part) {
  if (!pkg.trees[part]) pkg.trees[part] = parseXml(await pkg.zip.file(part).async("string"));
  return pkg.trees[part];
}
async function relsFor(pkg, part) {
  const i = part.lastIndexOf("/");
  const folder = part.slice(0, i), name = part.slice(i + 1);
  const f = pkg.zip.file(`${folder}/_rels/${name}.rels`);
  if (!f) return {};
  const doc = parseXml(await f.async("string"));
  const out = {};
  for (const r of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
    if (r.getAttribute("TargetMode") === "External") continue;
    out[r.getAttribute("Id")] = joinPath(folder, r.getAttribute("Target"));
  }
  return out;
}
async function textParts(pkg) {
  if (pkg.fmt === "docx") return [[pkg.main, "body", 1]];
  const pres = await tree(pkg, pkg.main);
  const rels = await relsFor(pkg, pkg.main);
  const list = pres.getElementsByTagNameNS(NS.p, "sldIdLst")[0];
  if (!list) return [];
  return kids(list).filter((e) => is(e, "p", "sldId")).map((s, i) => [rels[s.getAttributeNS(NS.r, "id")], `s${i + 1}`, i + 1]).filter((x) => x[0]);
}

/* ---------------- elements ---------------- */
const W_IGNORED = new Set(["lang", "noProof", "rFonts", "szCs", "bCs", "iCs"]);
const A_IGNORED = new Set(["lang", "altLang", "dirty", "err", "smtClean", "noProof", "spc", "kern"]);
function onOff(el) { if (!el) return false; const v = el.getAttributeNS(NS.w, "val"); return !(v === "0" || v === "false" || v === "none"); }
function wSig(run) {
  const rpr = kids(run).find((e) => is(e, "w", "rPr"));
  if (!rpr) return { sig: "", fmt: "" };
  const parts = kids(rpr).filter((c) => !W_IGNORED.has(c.localName)).map((c) => ser().serializeToString(c)).sort();
  const get = (n) => kids(rpr).find((e) => is(e, "w", n));
  const fmt = (onOff(get("b")) ? "b" : "") + (onOff(get("i")) ? "i" : "") + (get("u") && onOff(get("u")) ? "u" : "");
  return { sig: parts.join("|"), fmt };
}
function aSig(run) {
  const rpr = kids(run).find((e) => is(e, "a", "rPr"));
  if (!rpr) return { sig: "", fmt: "" };
  const attrs = Array.from(rpr.attributes).filter((a) => !A_IGNORED.has(a.localName)).map((a) => `${a.localName}=${a.value}`).sort();
  const ch = kids(rpr).filter((c) => !is(c, "a", "hlinkClick")).map((c) => ser().serializeToString(c)).sort();
  const fmt = (rpr.getAttribute("b") === "1" ? "b" : "") + (rpr.getAttribute("i") === "1" ? "i" : "") + (rpr.getAttribute("u") && rpr.getAttribute("u") !== "none" ? "u" : "");
  return { sig: attrs.join(",") + "|" + ch.join("|"), fmt };
}
function docxSegments(p) {
  const segs = [];
  let depth = 0;
  for (const run of Array.from(p.getElementsByTagNameNS(NS.w, "r"))) {
    if (nearest(run, (e) => is(e, "w", "p")) !== p) continue;
    for (const fc of kids(run)) if (is(fc, "w", "fldChar") && fc.getAttributeNS(NS.w, "fldCharType") === "begin") depth++;
    const anc = nearest(run, (e) => is(e, "w", "hyperlink") || is(e, "w", "fldSimple") || is(e, "w", "p"));
    const inLink = is(anc, "w", "hyperlink"), inSimple = is(anc, "w", "fldSimple");
    const { sig, fmt } = wSig(run);
    for (const c of kids(run)) {
      if (is(c, "w", "t")) {
        const text = c.textContent || "";
        if (depth > 0 || inSimple) segs.push({ text, kind: "field", protected: true, sig, fmt, node: c, run });
        else if (inLink) segs.push({ text, kind: "link", protected: true, sig, fmt, node: c, run });
        else segs.push({ text, kind: "text", protected: false, sig, fmt, node: c, run });
      } else if (is(c, "w", "tab")) segs.push({ text: "\t", kind: "tab", protected: true, sig, fmt: "", run });
      else if (is(c, "w", "br") || is(c, "w", "cr")) segs.push({ text: "\n", kind: "break", protected: true, sig, fmt: "", run });
      else if (is(c, "w", "fldChar") && c.getAttributeNS(NS.w, "fldCharType") === "end") depth = Math.max(0, depth - 1);
    }
  }
  return segs;
}
function pptxSegments(p) {
  const segs = [];
  for (const c of kids(p)) {
    if (is(c, "a", "r")) {
      const t = kids(c).find((e) => is(e, "a", "t"));
      if (!t) continue;
      const rpr = kids(c).find((e) => is(e, "a", "rPr"));
      const link = !!(rpr && kids(rpr).some((e) => is(e, "a", "hlinkClick")));
      const { sig, fmt } = aSig(c);
      segs.push({ text: t.textContent || "", kind: link ? "link" : "text", protected: link, sig, fmt, node: t, run: c });
    } else if (is(c, "a", "fld")) {
      const t = kids(c).find((e) => is(e, "a", "t"));
      segs.push({ text: (t && t.textContent) || "", kind: "field", protected: true, sig: "", fmt: "", node: t || null, run: c });
    } else if (is(c, "a", "br")) segs.push({ text: "\n", kind: "break", protected: true, sig: "", fmt: "", run: c });
  }
  return segs;
}
function finish(el) {
  let pos = 0;
  for (const s of el.segments) { s.start = pos; pos += s.text.length; s.end = pos; }
  el.text = el.segments.map((s) => s.text).join("");
  return el;
}
const isHeadingStyle = (s) => { s = (s || "").toLowerCase(); return s.startsWith("heading") || s === "title" || s === "subtitle" || s.startsWith("berschrift") || s.startsWith("berschrift"); };

export async function extract(pkg) {
  const out = [];
  for (const [part, key, number] of await textParts(pkg)) {
    const doc = await tree(pkg, part);
    if (pkg.fmt === "docx") {
      const body = doc.getElementsByTagNameNS(NS.w, "body")[0];
      let page = 1, idx = 0;
      for (const p of Array.from(body.getElementsByTagNameNS(NS.w, "p"))) {
        if (nearest(p, (e) => is(e, "mc", "Fallback"))) continue;
        const pPr = kids(p).find((e) => is(e, "w", "pPr"));
        const st = pPr && kids(pPr).find((e) => is(e, "w", "pStyle"));
        const style = st ? st.getAttributeNS(NS.w, "val") || "" : "";
        const el = finish({ id: `${key}:p${idx}`, part, index: idx, location: page, style, heading: isHeadingStyle(style),
          in_table: !!nearest(p, (e) => is(e, "w", "tbl")), segments: docxSegments(p), node: p, hash: await sha256(ser().serializeToString(p)) });
        out.push(el);
        idx++;
        page += p.getElementsByTagNameNS(NS.w, "lastRenderedPageBreak").length;
        page += Array.from(p.getElementsByTagNameNS(NS.w, "br")).filter((b) => b.getAttributeNS(NS.w, "type") === "page").length;
      }
    } else {
      let idx = 0;
      for (const p of Array.from(doc.getElementsByTagNameNS(NS.a, "p"))) {
        if (nearest(p, (e) => is(e, "mc", "Fallback"))) continue;
        const el = finish({ id: `${key}:p${idx}`, part, index: idx, location: number, style: "", heading: false,
          in_table: !!nearest(p, (e) => is(e, "a", "tbl")), segments: pptxSegments(p), node: p, hash: await sha256(ser().serializeToString(p)) });
        // slide titles count as headings for display
        const sp = nearest(p, (e) => is(e, "p", "sp"));
        const ph = sp && sp.getElementsByTagNameNS(NS.p, "ph")[0];
        if (ph && ["title", "ctrTitle"].includes(ph.getAttribute("type"))) el.heading = true;
        out.push(el);
        idx++;
      }
    }
  }
  return out;
}

/* Serializable view of elements for storage and display. */
export function serializeElements(elements) {
  return elements.map((e) => ({
    id: e.id, location: e.location, text: e.text, style: e.style, heading: e.heading, in_table: e.in_table, hash: e.hash,
    marks: e.segments.filter((s) => s.protected && (s.kind === "field" || s.kind === "link")).map((s) => [s.start, s.end, s.kind]),
    fmt: e.segments.filter((s) => !s.protected && s.text && s.fmt).map((s) => [s.start, s.end, s.fmt]),
  }));
}

const STOP = {
  en: "the and of to in is that for with as this are", de: "der die und das ist nicht mit von zu den ein eine",
  fr: "le la les et des est une du que pour dans pas", es: "el la los las y de que es en una por para", it: "il la che e di per una non sono del della gli",
};
export function detectLanguage(text) {
  const words = {};
  for (const w of text.toLowerCase().slice(0, 20000).match(/[a-zäöüßéèàçñ]+/g) || []) words[w] = (words[w] || 0) + 1;
  let best = "unknown", score = 0;
  for (const [lang, list] of Object.entries(STOP)) { const s = list.split(" ").reduce((n, w) => n + (words[w] || 0), 0); if (s > score) { score = s; best = lang; } }
  return score >= 5 ? best : "unknown";
}

export async function analyse(data) {
  const pkg = await openPackage(data);
  const elements = await extract(pkg);
  const text = elements.map((e) => e.text).join("\n");
  const stats = {
    words: text.split(/\s+/).filter(Boolean).length,
    paragraphs: elements.filter((e) => e.text.trim()).length,
    locations: Math.max(1, ...elements.map((e) => e.location)),
    location_label: pkg.fmt === "docx" ? "page" : "slide",
    language: detectLanguage(text),
    headings: elements.filter((e) => e.heading && e.text.trim()).length,
  };
  return { fmt: pkg.fmt, elements: serializeElements(elements), stats };
}

/* ---------------- tokens ---------------- */
export const TOKEN_RE = /⟦(\d+)⟧/g;
const YEAR = "(?:1[6-9]|20)\\d{2}[a-z]?";
const CITATION_PATTERNS = [
  new RegExp("\\((?:[^()]{0,160}?\\b" + YEAR + "(?:,\\s*(?:p|pp)\\.\\s*\\d+(?:[\\-\\u2013]\\d+)?)?;?\\s*)+\\)", "g"),
  new RegExp("\\b[A-Z][A-Za-z'\\-]+(?:\\s+(?:et al\\.|and|&)(?:\\s+[A-Z][A-Za-z'\\-]+)?)?\\s+\\(" + YEAR + "(?:,\\s*(?:p|pp)\\.\\s*\\d+)?\\)", "g"),
  /\[\d+(?:\s*[,\-–]\s*\d+)*\]/g,
  /[“"][^“”"]{0,400}?(?:\S+\s+){3,}[^“”"]*?[”"]/g,
];
export const PHYSICAL = new Set(["field", "link", "tab", "break", "format"]);
const tok = (id) => `⟦${id}⟧`;

function tokenizeText(text, tokens) {
  const spans = [];
  for (const pat of CITATION_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (m[0].length === 0) { pat.lastIndex++; continue; }
      if (spans.some(([a, b]) => s < b && e > a)) continue;
      spans.push([s, e, /^[“"]/.test(m[0]) ? "quote" : "citation"]);
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  let out = "", pos = 0;
  for (const [s, e, kind] of spans) {
    out += text.slice(pos, s);
    const id = tokens.length + 1;
    tokens.push({ id, kind, text: text.slice(s, e), seg: null });
    out += tok(id);
    pos = e;
  }
  return out + text.slice(pos);
}
function rangeSegs(el, start, end) {
  return el.segments.map((s, i) => [i, s]).filter(([, s]) => (s.start < end && s.end > start) || (s.start === s.end && start <= s.start && s.start < end));
}
function expand(el, start, end) {
  start = Math.max(0, start); end = Math.min(el.text.length, end);
  if (start >= end) throw new EditError("Empty selection.");
  for (const s of el.segments) if (s.protected && s.start < end && s.end > start) { start = Math.min(start, s.start); end = Math.max(end, s.end); }
  return [start, end];
}
function formatTerms(el, start, end) {
  const rng = rangeSegs(el, start, end).filter(([, s]) => !s.protected && s.text);
  if (rng.length < 2) return new Set();
  const weight = {};
  for (const [, s] of rng) weight[s.sig] = (weight[s.sig] || 0) + s.text.length;
  const dominant = Object.entries(weight).sort((a, b) => b[1] - a[1])[0][0];
  return new Set(rng.filter(([, s]) => s.sig !== dominant && s.text.trim() && s.text.trim().length <= 60).map(([i]) => i));
}
async function load(data, elementId) {
  const pkg = await openPackage(data);
  const elements = await extract(pkg);
  const el = elements.find((e) => e.id === elementId);
  if (!el) throw new EditError(`Paragraph ${elementId} not found in this version.`);
  return { pkg, elements, el };
}

export function templateFor(el, start, end) {
  start = start ?? 0; end = end ?? el.text.length;
  [start, end] = expand(el, start, end);
  const fmt = formatTerms(el, start, end);
  for (const i of fmt) { start = Math.min(start, el.segments[i].start); end = Math.max(end, el.segments[i].end); }
  const tokens = [];
  let tpl = "", buf = "";
  for (const [i, s] of rangeSegs(el, start, end)) {
    if (s.protected || fmt.has(i)) {
      tpl += tokenizeText(buf, tokens); buf = "";
      const id = tokens.length + 1;
      tokens.push({ id, kind: s.protected ? s.kind : "format", text: s.text, seg: i });
      tpl += tok(id);
      continue;
    }
    const a = Math.max(s.start, start), b = Math.min(s.end, end);
    buf += s.text.slice(a - s.start, b - s.start);
  }
  tpl += tokenizeText(buf, tokens);
  return {
    element_id: el.id, start, end, original: el.text.slice(start, end), template: tpl, tokens, element_hash: el.hash,
    context_before: el.text.slice(0, start).slice(-600), context_after: el.text.slice(end, end + 600),
  };
}
export async function prepare(data, elementId, start, end) {
  const { el } = await load(data, elementId);
  return templateFor(el, start, end);
}

export function checkTokens(tpl, newText) {
  const found = [...newText.matchAll(TOKEN_RE)].map((m) => +m[1]);
  const counts = {};
  for (const f of found) counts[f] = (counts[f] || 0) + 1;
  const missing = tpl.tokens.filter((t) => !counts[t.id]);
  if (missing.length) throw new EditError("Protected items missing from the new text: " + missing.map((t) => `${tok(t.id)} (${t.kind}: ${t.text.trim().slice(0, 40)})`).join(", "));
  const dup = Object.entries(counts).filter(([, c]) => c > 1).map(([i]) => i);
  if (dup.length) throw new EditError(`Protected items used more than once: ${dup.join(", ")}`);
  const known = new Set(tpl.tokens.map((t) => t.id));
  const unknown = found.filter((i) => !known.has(i));
  if (unknown.length) throw new EditError(`Unknown protected items in the new text: ${unknown.join(", ")}`);
  const physical = tpl.tokens.filter((t) => t.seg !== null && t.seg !== undefined).map((t) => t.id);
  const order = found.filter((i) => physical.includes(i));
  if (order.join(",") !== physical.join(",")) throw new EditError("Links, fields, line breaks and formatted terms must stay in their original order.");
}
export function restoreTokens(text, tokens) {
  const m = Object.fromEntries(tokens.map((t) => [t.id, t.text]));
  return text.replace(TOKEN_RE, (all, id) => (id in m ? m[id] : all));
}
function setText(node, text) {
  node.textContent = text;
  if (is(node, "w", "t")) {
    if (text !== text.trim() || text.includes("  ")) node.setAttributeNS(XML_NS, "xml:space", "preserve");
  }
}
function serializePart(doc) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + ser().serializeToString(doc.documentElement);
}

function anchorFor(seg) {
  const run = seg.run;
  if (!run) throw new EditError("Protected item has no run.");
  if (is(run, "w", "r")) {
    const link = nearest(run, (e) => is(e, "w", "hyperlink") || is(e, "w", "fldSimple") || is(e, "w", "p"));
    if (link && !is(link, "w", "p")) return [link, link];
    if (seg.kind === "field") {
      // complex field: from the run with fldChar begin to the run with fldChar end (siblings in the paragraph)
      const fc = (r, type) => kids(r).some((c) => is(c, "w", "fldChar") && c.getAttributeNS(NS.w, "fldCharType") === type);
      let first = run, last = run, depth = 0;
      for (let r = run; r; r = r.previousSibling) { if (r.nodeType !== 1) continue; if (fc(r, "end") && r !== run) depth++; if (fc(r, "begin")) { if (depth === 0) { first = r; break; } depth--; } }
      depth = 0;
      for (let r = run; r; r = r.nextSibling) { if (r.nodeType !== 1) continue; if (fc(r, "begin") && r !== run) depth++; if (fc(r, "end")) { if (depth === 0) { last = r; break; } depth--; } }
      return [first, last];
    }
  }
  return [run, run];
}
function insertRun([first, last], side, model, text) {
  const r = model.run.cloneNode(true);
  for (const c of kids(r)) if (!(is(c, "w", "rPr") || is(c, "a", "rPr"))) r.removeChild(c);
  const isW = is(r, "w", "r");
  const t = r.ownerDocument.createElementNS(isW ? NS.w : NS.a, isW ? "w:t" : "a:t");
  setText(t, text);
  if (isW && text !== text.trim()) t.setAttributeNS(XML_NS, "xml:space", "preserve");
  r.appendChild(t);
  if (side === "before") first.parentNode.insertBefore(r, first);
  else last.parentNode.insertBefore(r, last.nextSibling);
}

export async function apply(data, elementId, start, end, newTemplate, expectedHash) {
  const { pkg, el } = await load(data, elementId);
  const tpl = templateFor(el, start, end);
  if (expectedHash && tpl.element_hash !== expectedHash) throw new EditError("This paragraph changed since the proposal was made. Generate a new proposal.");
  checkTokens(tpl, newTemplate);
  start = tpl.start; end = tpl.end;
  const textTokens = tpl.tokens.filter((t) => t.seg === null);
  const physical = tpl.tokens.filter((t) => t.seg !== null);
  const restoreText = (s) => restoreTokens(s, textTokens);
  const pieces = physical.length ? newTemplate.split(new RegExp(`\\u27e6(?:${physical.map((t) => t.id).join("|")})\\u27e7`)).map(restoreText) : [restoreText(newTemplate)];
  const rng = rangeSegs(el, start, end);
  const fixed = new Set(physical.map((t) => t.seg));
  const chunks = [[]];
  for (const [i, s] of rng) { if (fixed.has(i)) chunks.push([]); else if (!s.protected) chunks[chunks.length - 1].push(i); }
  if (chunks.length !== pieces.length) throw new EditError("Internal mismatch between protected items and text pieces.");
  const segs = el.segments, newText = {};
  const keepPre = (s) => (s.start < start ? s.text.slice(0, start - s.start) : "");
  const keepSuf = (s) => (s.end > end ? s.text.slice(end - s.start) : "");
  for (const [i, s] of rng) if (!s.protected && !fixed.has(i)) newText[i] = keepPre(s) + keepSuf(s);
  chunks.forEach((chunk, ci) => {
    const piece = pieces[ci];
    if (chunk.length) { const s = segs[chunk[0]]; newText[chunk[0]] = keepPre(s) + piece + keepSuf(s); return; }
    if (!piece.trim()) return;
    // no editable run between protected items: add a new run next to the protected item
    const model = segs.find((x) => !x.protected && x.run) || null;
    if (!model) throw new EditError("No editable text in this paragraph to take formatting from.");
    if (ci === 0) insertRun(anchorFor(segs[physical[0].seg]), "before", model, piece);
    else insertRun(anchorFor(segs[physical[ci - 1].seg]), "after", model, piece);
  });
  for (const [i, txt] of Object.entries(newText)) {
    if (!segs[i].node) throw new EditError("Internal error: text segment without node.");
    setText(segs[i].node, txt);
  }
  const doc = await tree(pkg, el.part);
  pkg.zip.file(el.part, serializePart(doc), { createFolders: false });
  const out = await pkg.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const expected = el.text.slice(0, start) + restoreTokens(newTemplate, tpl.tokens) + el.text.slice(end);
  const report = await validate(data, out, el.id, expected);
  return { data: out, report, template: tpl };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export async function validate(oldData, newData, elementId, expectedText) {
  const a = await openPackage(oldData), b = await openPackage(newData);
  const ea = await extract(a), eb = await extract(b);
  if (ea.length !== eb.length) throw new EditError("Paragraph count changed. Edit refused.");
  const target = ea.find((e) => e.id === elementId);
  const allA = Object.keys(a.zip.files).sort().join("|"), allB = Object.keys(b.zip.files).sort().join("|");
  if (allA !== allB) throw new EditError("Package parts were added or removed. Edit refused.");
  let partsSame = 0;
  for (const n of a.names) {
    if (n === target.part) continue;
    const [x, y] = await Promise.all([a.zip.file(n).async("uint8array"), b.zip.file(n).async("uint8array")]);
    if (!sameBytes(x, y)) throw new EditError(`File part ${n} changed although it was not edited. Edit refused.`);
    partsSame++;
  }
  let unchanged = 0;
  for (let i = 0; i < ea.length; i++) {
    const x = ea[i], y = eb[i];
    if (x.id !== y.id) throw new EditError("Paragraph order changed. Edit refused.");
    if (x.id === elementId) {
      const pa = x.segments.filter((s) => s.protected).map((s) => s.text).join("\u0000");
      const pb = y.segments.filter((s) => s.protected).map((s) => s.text).join("\u0000");
      if (pa !== pb) throw new EditError("Protected items inside the paragraph changed. Edit refused.");
      if (expectedText !== undefined && y.text !== expectedText) throw new EditError("Edited paragraph does not contain the expected text. Edit refused.");
      continue;
    }
    if (x.hash !== y.hash) throw new EditError(`Paragraph ${x.id} changed although it was not selected. Edit refused.`);
    unchanged++;
  }
  return { element_id: elementId, paragraphs_verified_unchanged: unchanged, parts_verified_unchanged: partsSame, edited_part: target.part };
}
