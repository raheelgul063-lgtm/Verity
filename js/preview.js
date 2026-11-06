/* Design view: renders the real DOCX/PPTX (colours, shapes, fonts, images) and paints findings on top.
 * Renderers (loaded on demand): docx-preview (Apache-2.0) and pptx-preview (free for personal and commercial use). */
const LIBS = window.VERITY_LIBS || {
  docx: "https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/dist/docx-preview.min.js",
  pptx: "https://cdn.jsdelivr.net/npm/pptx-preview@1.0.7/dist/pptx-preview.umd.js",
};
const loaded = {};
function loadScript(src) {
  if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load the preview renderer. Check your connection."));
    document.head.appendChild(s);
  });
  return loaded[src];
}

let cache = { versionId: null, node: null, promise: null };

async function slideRatio(buf) {
  try {
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/presentation.xml").async("string");
    const m = xml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (m) return +m[2] / +m[1];
  } catch { /* default */ }
  return 9 / 16;
}

async function render(fmt, buf, width) {
  const node = document.createElement("div");
  node.className = `design design-${fmt}`;
  if (fmt === "docx") {
    await loadScript(LIBS.docx);
    await window.docx.renderAsync(buf.slice(0), node, null, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true });
  } else {
    await loadScript(LIBS.pptx);
    const ratio = await slideRatio(buf);
    const w = Math.max(480, Math.min(width, 1100));
    const host = document.createElement("div");
    node.appendChild(host);
    const pv = window.pptxPreview.init(host, { width: w, height: Math.round(w * ratio), mode: "list" });
    await pv.preview(buf.slice(0).buffer);
    node.querySelectorAll(".pptx-preview-slide-wrapper").forEach((s, i) => {
      s.dataset.loc = i + 1;
      const label = document.createElement("div");
      label.className = "page-label"; label.textContent = `Slide ${i + 1}`;
      s.parentNode.insertBefore(label, s);
    });
  }
  return node;
}

/** Mount the rendered document into host (re-uses the render for the same version). */
export async function mount(host, rep, getBlob) {
  const v = rep.version;
  if (cache.versionId !== v.id) {
    cache = { versionId: v.id, node: null, promise: (async () => render(rep.document.format, await getBlob(v), host.clientWidth - 48))() };
  }
  const node = cache.node || (cache.node = await cache.promise);
  if (cache.versionId !== v.id) return null;
  host.innerHTML = "";
  host.appendChild(node);
  return node;
}

/* ---------- highlights ---------- */
function unwrap(root) {
  root.querySelectorAll("mark.vh").forEach((m) => {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    p.normalize();
  });
}
function textIndex(scope) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let norm = "", map = [], last = " ";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue;
    for (let i = 0; i < t.length; i++) {
      let c = t[i];
      if (/[\s ]/.test(c)) { if (last === " ") continue; c = " "; }
      else if ("‘’".includes(c)) c = "'";
      else if ("“”".includes(c)) c = '"';
      norm += c.toLowerCase(); map.push([nodes.length, i]); last = c;
    }
    nodes.push(n);
  }
  return { nodes, norm, map };
}
const normText = (s) => s.replace(/[\s ]+/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim().toLowerCase();

function wrapRange(idx, from, to, cls, id) {
  // group the matched characters by text node, then wrap each node's slice
  const parts = new Map();
  for (let k = from; k < to; k++) {
    const [ni, off] = idx.map[k];
    const p = parts.get(ni) || [off, off + 1];
    p[0] = Math.min(p[0], off); p[1] = Math.max(p[1], off + 1);
    parts.set(ni, p);
  }
  for (const [ni, [a, b]] of [...parts.entries()].reverse()) {
    const node = idx.nodes[ni];
    const r = document.createRange();
    r.setStart(node, a); r.setEnd(node, b);
    const m = document.createElement("mark");
    m.className = `vh ${cls}`; m.dataset.f = id;
    try { r.surroundContents(m); } catch { /* node split by another highlight */ }
  }
}

/** Paint findings. Returns ids that could not be located in the rendering. */
export function highlight(node, findings, sel, fmt) {
  unwrap(node);
  const missing = [];
  const byScope = new Map();
  for (const f of findings) {
    let scope = node;
    if (fmt === "pptx") scope = node.querySelector(`.pptx-preview-slide-wrapper[data-loc="${f.location}"]`) || node;
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(f);
  }
  for (const [scope, fs] of byScope) {
    // longest first so short findings do not split long ones
    fs.sort((a, b) => b.text.length - a.text.length);
    for (const f of fs) {
      const idx = textIndex(scope);
      const needle = normText(f.text);
      if (!needle) continue;
      let at = idx.norm.indexOf(needle);
      if (at < 0 && needle.length > 40) {
        // renderer may drop or add a character at line breaks: anchor on start and end
        const head = needle.slice(0, 30), tail = needle.slice(-30);
        const h = idx.norm.indexOf(head), t = h >= 0 ? idx.norm.indexOf(tail, h) : -1;
        if (h >= 0 && t >= 0 && t - h < needle.length * 1.3) { wrapRange(idx, h, t + tail.length, cls(f, sel), f.id); continue; }
      }
      if (at < 0) { missing.push(f.id); continue; }
      wrapRange(idx, at, at + needle.length, cls(f, sel), f.id);
    }
  }
  return missing;
}
function cls(f, sel) {
  const base = ["fixed", "fixed_pending", "reviewed"].includes(f.state) ? "done" : f.type === "ai" ? "ai" : f.match_type || "identical";
  return base + (f.id === sel ? " sel" : "");
}
export function setSelected(node, id, scroll) {
  node.querySelectorAll("mark.vh.sel").forEach((m) => m.classList.remove("sel"));
  const ms = node.querySelectorAll(`mark.vh[data-f="${CSS.escape(id)}"]`);
  ms.forEach((m) => m.classList.add("sel"));
  if (scroll && ms[0]) { ms[0].scrollIntoView({ behavior: "smooth", block: "center" }); ms.forEach((m) => m.classList.add("pulse")); }
  return ms.length > 0;
}
export function scrollToLocation(node, fmt, loc) {
  const el = fmt === "pptx" ? node.querySelector(`.pptx-preview-slide-wrapper[data-loc="${loc}"]`) : node.querySelectorAll("section.docx")[loc - 1];
  el && el.scrollIntoView({ behavior: "smooth", block: "start" });
}
