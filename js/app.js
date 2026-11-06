/* Verity AI web app. Plain JS modules, hosted on GitHub Pages, data in Supabase. */
import * as D from "./data.js";
import * as P from "./preview.js";
const S = {
  me: null, status: null, report: null, docId: null,
  filter: "all", loc: null, sel: null, right: "detail", proposal: null, manual: null, lastResult: null,
  fixScope: "both",
  view: localStorage.getItem("verity_view") || "design",
  opts: JSON.parse(localStorage.getItem("verity_opts") || "null") || { mode: "clarity", writing_level: "postgraduate", citation_style: "APA 7", plag_action: "paraphrase" },
  poll: null, busy: false,
};
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);
const TYPE_LABEL = { ai: "AI writing", identical: "Identical", minor_changes: "Minor changes", paraphrased: "Paraphrased" };
const STATE_LABEL = { open: "Open", fixed: "Fixed", fixed_pending: "Fixed, awaiting re-check", reviewed: "Reviewed", stale: "Needs re-scan" };

function toast(msg, bad) {
  document.querySelectorAll(".toast").forEach((x) => x.remove());
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6500 : 3200);
}
async function guarded(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status === 428 || e.message === "consent_required") { if (await askConsent()) return guarded(fn); return; }
    if (e.status === 401) { S.me = null; return renderAuth(); }
    console.error(e);
    toast(e.message, true);
  }
}
function saveOpts() { localStorage.setItem("verity_opts", JSON.stringify(S.opts)); }

/* ---------------- boot ---------------- */
async function boot() {
  S.status = await D.status();
  renderChips();
  try { S.me = await D.me(); } catch { S.me = null; }
  D.sb.auth.onAuthStateChange(async (ev) => { if (ev === "SIGNED_IN" && !S.me) { S.me = await D.me(); route(); } });
  route();
}
window.addEventListener("hashchange", route);
$("#brand").onclick = () => go("/");
$("#logout").onclick = async () => { await D.signOut(); S.me = null; go("/"); };
function go(path) { if (location.hash === "#" + path) route(); else location.hash = path; }
function route() {
  clearTimeout(S.poll);
  if (!S.me) return renderAuth();
  $("#userBox").classList.remove("hidden");
  $("#credits").textContent = `${S.me.credits} credits`;
  $("#email").textContent = S.me.email;
  const m = location.hash.match(/^#\/doc\/([a-f0-9-]+)/);
  if (m) openDoc(m[1]); else renderDash();
}
function renderChips() {
  const st = S.status;
  const c = (label, mode, title) => `<span class="chip ${mode}" title="${esc(title)}">${label}: ${mode}</span>`;
  $("#provChips").innerHTML =
    c(st.copyleaks === "sample" ? "Detector" : (st.detector || "Copyleaks"), st.copyleaks, st.copyleaks === "sample" ? "No detector key: findings are SAMPLE data, not detection." : st.copyleaks === "sandbox" ? "Sandbox returns mock results for free testing." : `Live detection by ${st.detector || "Copyleaks"}`) + " " +
    c("Claude", st.claude, st.claude === "sample" ? "No Anthropic key: rewrites return the text unchanged." : `Model ${st.claude_model}`) + " " +
    (st.unreachable ? '<span class="chip sample" title="Could not reach the Verity server functions">offline</span> ' : "");
}

/* ---------------- auth ---------------- */
function renderAuth(mode = "login") {
  $("#userBox").classList.add("hidden");
  app.innerHTML = `<div class="auth">
    <h1>${mode === "login" ? "Log in" : "Create account"}</h1>
    <p>Check Word and PowerPoint files for AI writing and plagiarism, then fix only the flagged passages. Everything else in your file stays exactly the same.</p>
    <div class="field"><label>Email</label><input id="em" type="email" autocomplete="email"></div>
    <div class="field"><label>Password (8+ characters)</label><input id="pw" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}"></div>
    <div class="err" id="aerr"></div>
    <button class="btn primary" id="go" style="width:100%;justify-content:center">${mode === "login" ? "Log in" : "Create account"}</button>
    <p style="margin:14px 0 0;font-size:13px">${mode === "login" ? 'No account? <a href="#" id="sw">Create one</a>' : 'Have an account? <a href="#" id="sw">Log in</a>'}</p>
  </div>`;
  $("#sw").onclick = (e) => { e.preventDefault(); renderAuth(mode === "login" ? "register" : "login"); };
  const submit = async () => {
    try {
      const email = $("#em").value.trim(), pw = $("#pw").value;
      if (pw.length < 8) throw new Error("Use at least 8 characters for the password.");
      if (mode === "login") await D.signIn(email, pw);
      else {
        const r = await D.signUp(email, pw);
        if (r.needsConfirm) { $("#aerr").style.color = "var(--ok)"; $("#aerr").textContent = "Check your inbox and click the confirmation link, then log in."; return; }
      }
      S.me = await D.me();
      route();
    } catch (e) { $("#aerr").textContent = e.message; }
  };
  $("#go").onclick = submit;
  $("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

/* ---------------- dashboard ---------------- */
async function renderDash() {
  const docs = await guarded(() => D.listDocs()) || [];
  app.innerHTML = `<div class="dash">
    <div class="drop" id="drop"><strong>Drop a .docx or .pptx here</strong> or click to choose a file<br><span class="note">Up to 25 MB. Your original file is kept unchanged; every fix creates a new version.</span>
      <input type="file" id="file" accept=".docx,.pptx" class="hidden"></div>
    <p class="note" style="margin:-14px 0 22px">No file at hand? Try <a href="samples/sample-thesis.docx" download>a sample thesis (.docx)</a> or <a href="samples/sample-deck.pptx" download>a sample deck (.pptx)</a>.</p>
    <h2>Your documents</h2>
    ${docs.length ? `<table class="list"><thead><tr><th>Name</th><th>Type</th><th>Words</th><th>Pages / slides</th><th>Version</th><th>Open findings</th><th>Uploaded</th><th></th></tr></thead><tbody>
      ${docs.map((d) => `<tr class="row" data-id="${d.id}"><td>${esc(d.name)}</td><td><span class="fmt">${d.format.toUpperCase()}</span></td><td>${d.stats.words.toLocaleString()}</td>
        <td>${d.stats.locations} ${d.stats.location_label}${d.stats.locations === 1 ? "" : "s"}${d.format === "docx" ? " (approx.)" : ""}</td><td>v${d.version}</td><td>${d.open_findings}</td>
        <td>${new Date(d.created_at).toLocaleDateString()}</td><td><button class="btn ghost small" data-del="${d.id}" title="Delete document and all versions">Delete</button></td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No documents yet. Upload a thesis, paper or slide deck to start.</div>`}
  </div>`;
  const drop = $("#drop"), file = $("#file");
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) doUpload(e.dataTransfer.files[0]); };
  file.onchange = () => file.files[0] && doUpload(file.files[0]);
  app.querySelectorAll("tr.row").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("[data-del]")) go(`/doc/${tr.dataset.id}`); }));
  app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this document and every version? This cannot be undone.")) return;
    await guarded(() => D.deleteDoc(b.dataset.del)); toast("Document deleted."); renderDash();
  }));
}
async function doUpload(f) {
  const drop = $("#drop");
  drop.innerHTML = `<span class="spin"></span> Uploading and reading ${esc(f.name)}...`;
  const d = await guarded(() => D.upload(f));
  if (d) go(`/doc/${d.id}`); else renderDash();
}

/* ---------------- workspace ---------------- */
async function openDoc(id, keep) {
  if (S.docId !== id) { S.sel = null; S.right = "detail"; S.loc = null; S.filter = "all"; S.proposal = null; S.lastResult = null; }
  S.docId = id;
  const rep = await guarded(() => D.report(id));
  if (!rep) return;
  S.report = rep;
  renderWS();
  const active = Object.values(rep.scans).some((s) => ["queued", "running", "submitted", "exporting"].includes(s.status));
  clearTimeout(S.poll);
  if (active) S.poll = setTimeout(() => location.hash.includes(id) && openDoc(id, true), 4000);
}
function F() { return S.report.findings; }
function findingById(id) { return F().find((f) => f.id === id); }
function needsCitation(f) { return f.type === "plagiarism" && !(f.citation_status?.cited || f.citation_status?.quoted); }
function visibleFindings() {
  let xs = F().slice();
  if (S.filter === "ai") xs = xs.filter((f) => f.type === "ai" && f.state === "open");
  else if (S.filter === "plagiarism") xs = xs.filter((f) => f.type === "plagiarism" && f.state === "open");
  else if (S.filter === "citation") xs = xs.filter((f) => needsCitation(f) && f.state === "open");
  else if (S.filter === "fixed") xs = xs.filter((f) => ["fixed", "fixed_pending", "reviewed"].includes(f.state));
  else xs = xs.filter((f) => f.state === "open" || f.state === "stale");
  if (S.loc) xs = xs.filter((f) => f.location === S.loc);
  const rank = (f) => (f.type === "plagiarism" ? ({ identical: 3, minor_changes: 2, paraphrased: 1 }[f.match_type] || 1) + 1 : (f.score ?? 0.5) * 2);
  return xs.sort((a, b) => a.location - b.location || rank(b) - rank(a));
}
function renderWS() {
  const r = S.report;
  const st = r.version.stats;
  app.innerHTML = `<div class="ws">
    <div class="ws-head">
      <button class="btn ghost small" id="back">All documents</button>
      <span class="title" title="${esc(r.document.name)}">${esc(r.document.name)}</span>
      <span class="badge">v${r.version.number}</span>
      <span class="badge">${st.words.toLocaleString()} words</span>
      <span class="badge">${st.locations} ${st.location_label}s${r.document.format === "docx" ? " (approx.)" : ""}</span>
      <span class="badge">${esc(st.language).toUpperCase()}</span>
      <div class="spacer"></div>
      <div class="seg" id="scanSeg"><button data-k="ai,plagiarism">Scan AI + plagiarism</button><button data-k="ai">AI only</button><button data-k="plagiarism">Plagiarism only</button></div>
      <div class="seg" id="scopeSeg">${["ai", "plagiarism", "both"].map((s) => `<button data-s="${s}" class="${S.fixScope === s ? "on" : ""}">${s === "ai" ? "AI" : s === "plagiarism" ? "Plagiarism" : "Both"}</button>`).join("")}</div>
      <button class="btn accent" id="fixAll">Fix all with AI</button>
      <button class="btn" id="settingsBtn">Fix settings</button>
      <button class="btn" id="histBtn">History</button>
      <button class="btn" data-dl="${r.version.id}">Download v${r.version.number}</button>
    </div>
    <div class="summary">${renderSummary()}</div>
    <div class="cols">
      <div class="left">${renderLeft()}</div>
      <div class="center" id="center">${renderCenter()}</div>
      <div class="right" id="right">${renderRight()}</div>
    </div></div>`;
  bindWS();
}
function renderSummary() {
  const r = S.report, ai = r.scans.ai, pl = r.scans.plagiarism;
  const open = F().filter((f) => f.state === "open");
  const scanState = (s) => !s ? "Not scanned" : s.status === "done" ? (s.mode === "sample" ? "Sample data, no API key" : `${esc(s.provider)} (${s.mode})`) : s.status === "error" ? `Error: ${esc(s.message).slice(0, 80)}` : `<span class="spin"></span> ${esc(s.status)}${s.message ? ": " + esc(s.message) : ""}`;
  const aiVal = ai && ai.status === "done" ? (ai.mode === "sample" ? "Sample" : pct(ai.summary.ai_share)) : "n/a";
  const pls = pl?.summary || {};
  const plVal = pl && pl.status === "done" ? (pl.mode === "sample" ? "Sample" : `${(pls.identical ?? 0) + (pls.minor_changes ?? 0) + (pls.paraphrased ?? 0)}%`) : "n/a";
  const scanned = Math.max(ai?.words || 0, pl?.words || 0);
  const cov = scanned ? Math.min(100, Math.round((100 * scanned) / r.version.stats.words)) : null;
  return `
    <div class="metric"><div class="k">AI content</div><div class="v ai">${aiVal}</div><div class="s">${scanState(ai)}</div></div>
    <div class="metric"><div class="k">Similarity</div><div class="v plag">${plVal}</div><div class="s">${pl && pl.status === "done" && pl.mode !== "sample" ? `Identical ${pls.identical ?? 0}% · Minor ${pls.minor_changes ?? 0}% · Paraphrased ${pls.paraphrased ?? 0}%` : scanState(pl)}</div>
      ${pl && pl.status === "done" && pl.mode !== "sample" ? `<div class="bars"><i style="width:${pls.identical || 0}%;background:var(--identical)"></i><i style="width:${pls.minor_changes || 0}%;background:var(--minor)"></i><i style="width:${pls.paraphrased || 0}%;background:var(--para)"></i></div>` : ""}</div>
    <div class="metric"><div class="k">Flagged passages</div><div class="v">${open.length}</div><div class="s">${open.filter((f) => f.type === "ai").length} AI · ${open.filter((f) => f.type === "plagiarism").length} similarity</div></div>
    <div class="metric"><div class="k">Matched sources</div><div class="v">${r.sources.length}</div><div class="s">${r.sources[0] ? esc(r.sources[0].title).slice(0, 40) : "none"}</div></div>
    <div class="metric"><div class="k">Need citation</div><div class="v">${open.filter(needsCitation).length}</div><div class="s">${F().filter((f) => f.state === "reviewed").length} reviewed · ${F().filter((f) => f.state === "fixed" || f.state === "fixed_pending").length} fixed</div></div>
    <div class="metric"><div class="k">Coverage</div><div class="v">${cov === null ? "n/a" : cov + "%"}</div><div class="s">${scanned ? scanned.toLocaleString() + " words scanned" : "Reference list excluded"}</div></div>
    <div class="warnline"><strong>Read results with care.</strong> AI detection is probabilistic and is not proof of authorship. Formal, technical, non-native and highly standardised academic writing can be flagged wrongly. Similarity is not plagiarism: quoted and cited material and common phrases also match. ${S.status.copyleaks === "sample" ? "<br><strong>Sample mode:</strong> no detector key is set, so findings are placeholders to test the workflow." : ""}${S.status.copyleaks === "sandbox" ? "<br><strong>Copyleaks sandbox:</strong> results are mock data from Copyleaks, not a real detection." : ""}</div>`;
}
function renderLeft() {
  const r = S.report, n = r.version.stats.locations, label = r.version.stats.location_label;
  const counts = {};
  F().filter((f) => f.state === "open").forEach((f) => (counts[f.location] = (counts[f.location] || 0) + 1));
  const tabs = [["all", "All"], ["ai", "AI"], ["plagiarism", "Plagiarism"], ["citation", "Needs citation"], ["fixed", "Fixed"]];
  const items = visibleFindings();
  return `
    <div class="sec"><h4>${label === "slide" ? "Slides" : "Pages (approx.)"}</h4><div class="locs">
      ${Array.from({ length: n }, (_, i) => i + 1).map((i) => `<div class="loc" data-loc="${i}" style="${S.loc === i ? "border-color:var(--accent);background:var(--accent-soft)" : ""}">${i}<span class="n ${counts[i] ? "hot" : ""}">${counts[i] || 0}</span></div>`).join("")}
    </div>${S.loc ? `<div class="actions"><button class="btn small" id="locFix">Fix ${label} ${S.loc} with AI</button><button class="btn small ghost" id="locClear">Show all</button></div>` : ""}</div>
    <div class="sec"><div class="tabs">${tabs.map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    ${items.length ? items.map(findingRow).join("") : `<div class="empty">${F().length ? "Nothing in this view." : "No findings yet. Run a scan from the top bar."}</div>`}
    ${r.sources.length ? `<div class="sec"><h4>Sources</h4>${r.sources.map((s) => `<div style="margin:6px 0;font-size:12.5px">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title || "Source details unavailable from provider")}<div class="note">${s.matched_words} matched words · ${s.passages} passage${s.passages === 1 ? "" : "s"}</div></div>`).join("")}</div>` : ""}`;
}
function color(f) { return f.type === "ai" ? "var(--ai)" : ({ identical: "var(--identical)", minor_changes: "var(--minor)", paraphrased: "var(--para)" }[f.match_type] || "var(--identical)"); }
function findingRow(f) {
  const lab = S.report.version.stats.location_label === "slide" ? "Slide" : "Page";
  const sc = f.type === "ai" ? (f.score != null ? pct(f.score) : "") : TYPE_LABEL[f.match_type] || "";
  return `<div class="finding ${S.sel === f.id ? "sel" : ""}" data-id="${f.id}"><div class="bar" style="background:${color(f)}"></div>
    <div><div class="t">${esc(f.text)}</div><div class="m">${f.type === "ai" ? "AI" : "Similarity"} · ${lab} ${f.location}${f.state !== "open" ? ` · <span class="state ${f.state}">${STATE_LABEL[f.state]}</span>` : ""}${needsCitation(f) && f.state === "open" ? ' · <span class="state">no citation</span>' : ""}</div></div>
    <div class="sc" style="color:${color(f)}">${sc}</div></div>`;
}
function viewToggle() {
  return `<div class="viewbar"><div class="seg" id="viewSeg"><button data-v="design" class="${S.view === "design" ? "on" : ""}">Design view</button><button data-v="text" class="${S.view === "text" ? "on" : ""}">Text view</button></div>
    <span class="note">${S.view === "design" ? "Your file as it looks. Highlights show flagged passages." : "Plain text with protected citations and links marked."}</span><span class="note" id="placeNote"></span></div>`;
}
function renderCenter() {
  if (S.view === "design") return viewToggle() + `<div id="designHost"><div class="empty"><span class="spin"></span> Rendering your document with its original design...</div></div>`;
  return viewToggle() + renderTextPages();
}
async function mountDesign() {
  const host = $("#designHost");
  if (!host) return;
  const r = S.report;
  let node;
  try { node = await P.mount(host, r, D.versionBlob); }
  catch (e) { host.innerHTML = `<div class="empty">Design view could not render this file (${esc(e.message)}). Showing the text view instead.</div>` + renderTextPages(); return; }
  if (!node || !$("#designHost")) return;
  const missing = P.highlight(node, F().filter((f) => f.state !== "stale"), S.sel, r.document.format);
  const note = $("#placeNote");
  if (note) note.textContent = missing.length ? ` ${missing.length} finding${missing.length === 1 ? "" : "s"} could not be placed on the design; they are in the list and in Text view.` : "";
  if (S.sel) P.setSelected(node, S.sel, false);
  if (S.loc) P.scrollToLocation(node, r.document.format, S.loc);
}
function renderTextPages() {
  const r = S.report, slide = r.version.stats.location_label === "slide";
  const byLoc = {};
  r.elements.forEach((e) => (byLoc[e.location] = byLoc[e.location] || []).push(e));
  const fByEl = {};
  F().forEach((f) => { if (f.state !== "stale") (fByEl[f.element_id] = fByEl[f.element_id] || []).push(f); });
  const edited = new Set(r.edits.filter((e) => e.status === "applied" && e.to_version_id === r.version.id).map((e) => e.element_id));
  return Object.keys(byLoc).sort((a, b) => a - b).map((loc) => `
    <div class="page-label">${slide ? "Slide" : "Page"} ${loc}${slide ? "" : " (approx.)"}</div>
    <div class="page ${slide ? "slide" : ""}" data-loc="${loc}">
      ${byLoc[loc].filter((e) => e.text.trim()).map((e) => `<p class="para ${e.heading ? "h" : ""} ${e.in_table ? "tbl" : ""} ${edited.has(e.id) ? "edited" : ""}" data-el="${e.id}">${renderPara(e, fByEl[e.id] || [])}</p>`).join("") || '<p class="para note">(no text)</p>'}
    </div>`).join("");
}
function renderPara(e, fs) {
  const t = e.text, cuts = new Set([0, t.length]);
  fs.forEach((f) => { cuts.add(Math.max(0, f.start)); cuts.add(Math.min(t.length, f.end)); });
  (e.marks || []).forEach(([a, b]) => { cuts.add(a); cuts.add(b); });
  (e.fmt || []).forEach(([a, b]) => { cuts.add(a); cuts.add(b); });
  const pts = [...cuts].filter((x) => x >= 0 && x <= t.length).sort((a, b) => a - b);
  let out = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a === b) continue;
    let piece = esc(t.slice(a, b));
    const fm = (e.fmt || []).find(([x, y]) => x <= a && y >= b);
    if (fm) { if (fm[2].includes("b")) piece = `<b>${piece}</b>`; if (fm[2].includes("i")) piece = `<i>${piece}</i>`; }
    const mk = (e.marks || []).find(([x, y]) => x <= a && y >= b);
    if (mk) piece = `<span class="${mk[2] === "link" ? "lnk" : "cite"}" title="${mk[2] === "link" ? "Hyperlink (protected)" : "Field or citation (protected)"}">${piece}</span>`;
    const hit = fs.filter((f) => f.start <= a && f.end >= b);
    if (hit.length) {
      const f = hit.find((x) => x.id === S.sel) || hit.find((x) => x.state === "open") || hit[0];
      const cls = ["fixed", "fixed_pending", "reviewed"].includes(f.state) ? "done" : f.type === "ai" ? "ai" : f.match_type || "identical";
      piece = `<mark class="${cls} ${f.id === S.sel ? "sel" : ""}" data-f="${f.id}">${piece}</mark>`;
    }
    out += piece;
  }
  return out;
}

/* ---------------- right panel ---------------- */
function optsForm() {
  const o = S.opts, sel = (k, items) => `<select data-o="${k}">${items.map(([v, l]) => `<option value="${v}" ${o[k] === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  return `<div class="opts">
    <div class="field"><label>Rewrite mode</label>${sel("mode", [["clarity", "Improve clarity"], ["academic_tone", "Academic tone"], ["grammar", "Grammar only"], ["simplify", "Simplify"], ["own_voice", "Plain, natural prose"]])}</div>
    <div class="field"><label>Writing level</label>${sel("writing_level", [["undergraduate", "Undergraduate"], ["postgraduate", "Postgraduate"], ["doctoral", "Doctoral"], ["professional", "Professional"]])}</div>
    <div class="field"><label>Citation style</label>${sel("citation_style", [["APA 7", "APA 7"], ["Harvard", "Harvard"], ["MLA 9", "MLA 9"], ["IEEE", "IEEE"], ["Chicago author-date", "Chicago"]])}</div>
    <div class="field"><label>Similarity fix</label>${sel("plag_action", [["paraphrase", "Paraphrase + cite"], ["quote", "Quote + cite"]])}</div>
  </div>`;
}
function renderRight() {
  if (S.right === "history") return renderHistory();
  if (S.right === "proposal" && S.proposal) return renderProposal();
  if (S.right === "manual" && S.manual) return renderManual();
  if (S.right === "result" && S.lastResult) return renderResult();
  const f = S.sel && findingById(S.sel);
  if (!f) return `<div class="empty">Select a highlighted passage or a finding on the left to see why it was flagged and fix it.<br><br>
    <span style="display:inline-block;text-align:left">
    <mark class="ai">AI writing</mark><br><mark class="identical">Identical match</mark><br><mark class="minor_changes">Minor changes</mark><br><mark class="paraphrased">Paraphrased</mark><br><span class="cite">Protected citation</span> · <span class="lnk">link</span></span></div>`;
  const lab = S.report.version.stats.location_label === "slide" ? "Slide" : "Page";
  const ev = f.evidence || {};
  let body = "";
  if (f.type === "ai") {
    body = `<div class="kv">
      <div class="k">Location</div><div>${lab} ${f.location} · paragraph ${esc(f.element_id.split(":p")[1])}</div>
      <div class="k">Detector</div><div>${esc(ev.provider || "")} (${esc(ev.mode || "")})${ev.model_version ? ", model " + esc(ev.model_version) : ""}</div>
      <div class="k">Section score</div><div>${f.score != null ? pct(f.score) + " probability (provider)" : "Not supplied by the provider"}</div>
      <div class="k">Document AI share</div><div>${ev.document_ai_share != null ? pct(ev.document_ai_share) : "n/a"}</div>
      <div class="k">AI Logic phrases</div><div>${(ev.ai_logic_phrases || []).length ? ev.ai_logic_phrases.length + " phrases the provider marked as typical of AI text" : "None supplied"}</div>
      <div class="k">Status</div><div><span class="state ${f.state}">${STATE_LABEL[f.state]}</span> ${esc(f.note)}</div></div>
      <div class="note"><strong>Why this may be a false positive:</strong> detectors rate predictable, uniform phrasing. Formulaic academic sections (methods, definitions, literature summaries), translated text and non-native writing are often flagged even when written by a person. Treat this as a prompt for manual review.</div>`;
  } else {
    const s = f.source, cs = f.citation_status || {};
    body = `<div class="kv">
      <div class="k">Location</div><div>${lab} ${f.location} · paragraph ${esc(f.element_id.split(":p")[1])}</div>
      <div class="k">Match type</div><div style="color:${color(f)}">${TYPE_LABEL[f.match_type] || f.match_type}</div>
      <div class="k">Source</div><div>${s ? (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title)) : "Source details unavailable from provider"}</div>
      ${s && (s.author || s.date || s.publisher) ? `<div class="k">Published</div><div>${esc([s.author, s.publisher, s.date].filter(Boolean).join(", "))}</div>` : ""}
      <div class="k">Source match</div><div>${s ? s.matched_words + " matched words in this source" : "n/a"}</div>
      <div class="k">Quoted</div><div>${cs.quoted ? "Yes" : "No"}</div>
      <div class="k">Citation nearby</div><div>${cs.cited ? "Yes" : "No"}</div>
      <div class="k">Status</div><div><span class="state ${f.state}">${STATE_LABEL[f.state]}</span> ${esc(f.note)}</div></div>
      ${f.source_excerpt ? `<h4 style="font-size:12px;color:var(--ink-3);margin:10px 0 6px">SOURCE TEXT</h4><div class="quote">${esc(f.source_excerpt)}</div>` : '<div class="note">Matched source passage not available from the provider.</div>'}
      <div class="note" style="margin-top:10px"><strong>Why review it:</strong> ${cs.cited || cs.quoted ? "the passage seems attributed. Check the citation is correct and complete, then mark it reviewed." : "the words match an external source and no quotation marks or citation were found next to it."}</div>`;
  }
  return `<div class="detail">
    <h3><span style="width:10px;height:10px;border-radius:2px;background:${color(f)};display:inline-block"></span>${f.type === "ai" ? "AI writing finding" : "Similarity finding"}</h3>
    <div class="quote" style="margin-top:10px">${esc(f.text)}</div>
    ${body}
    ${f.state === "open" || f.state === "stale" ? `<div class="actions">
      <button class="btn primary" id="aiFix">Fix with AI</button>
      <button class="btn" id="paraFix" title="Fixes every open finding in this paragraph">Fix whole paragraph</button>
      <button class="btn" id="manualBtn">Edit myself</button>
      <button class="btn ghost" id="reviewBtn">Mark reviewed</button></div>
      ${optsForm()}` : ""}
  </div>`;
}
function tokenLegend(tokens) {
  if (!tokens?.length) return "";
  const kind = { field: "citation field", link: "hyperlink", tab: "tab", break: "line break", citation: "citation", quote: "direct quote", format: "formatted term" };
  return `<div class="legend"><strong>Protected items</strong> (kept exactly as they are):<br>${tokens.map((t) => `<span class="tok">⟦${t.id}⟧</span> ${kind[t.kind] || t.kind}: ${esc(t.text.trim() || (t.kind === "tab" ? "tab" : "line break"))}`).join("<br>")}</div>`;
}
function renderProposal() {
  const p = S.proposal;
  if (p.status === "failed") return `<div class="detail"><h3>Could not create a proposal</h3><div class="note warn">${esc(p.error)}</div><div class="actions"><button class="btn" id="backDetail">Back</button><button class="btn" id="regen">Try again</button></div></div>`;
  return `<div class="detail">
    <h3>Proposed change</h3><div class="note">${esc(p.provider)} · ${esc(p.scope)} · ${esc(p.mode)}</div>
    <h4 style="font-size:12px;color:var(--ink-3);margin:14px 0 6px">ORIGINAL</h4><div class="quote">${esc(p.before)}</div>
    <h4 style="font-size:12px;color:var(--ink-3);margin:14px 0 6px">PROPOSAL (CHANGES MARKED)</h4><div class="quote diff">${diffHtml(p.before, p.after)}</div>
    <div class="note" style="margin-top:10px"><strong>What changed:</strong> ${esc(p.explanation)}</div>
    ${tokenLegend(p.tokens)}
    <div id="propEdit" class="hidden"><textarea class="edit" id="propText">${esc(p.proposal)}</textarea><button class="btn small" id="propSave">Save my changes</button></div>
    <div class="actions"><button class="btn primary" id="accept">Accept</button><button class="btn" id="propEditBtn">Edit proposal</button><button class="btn" id="regen">Regenerate</button><button class="btn ghost" id="rejectBtn">Reject</button></div>
    <div class="note">Nothing in your file changes until you accept. Only this passage is replaced; the rest of the document is verified unchanged.</div>
  </div>`;
}
function renderManual() {
  const m = S.manual;
  return `<div class="detail"><h3>Edit this passage yourself</h3>
    <div class="note">Change the text freely. Keep every <span class="tok">⟦n⟧</span> marker: each one stands for a citation, link, quote or formatted term that stays exactly as it is.</div>
    <textarea class="edit" id="manText" style="margin-top:10px">${esc(m.template)}</textarea>
    ${tokenLegend(m.tokens)}
    <div class="actions"><button class="btn primary" id="manSave">Save to document</button><button class="btn ghost" id="backDetail">Cancel</button></div></div>`;
}
function renderResult() {
  const e = S.lastResult;
  const v = e.validation || {}, rs = e.rescan || {};
  return `<div class="detail"><h3>${e.status === "applied" ? "Change applied" : "Change not applied"}</h3>
    ${e.status === "applied" ? `<div class="note" style="color:var(--ok)">Saved as a new version. Verified: ${v.paragraphs_verified_unchanged} other paragraphs and ${v.parts_verified_unchanged} other file parts are byte-for-byte unchanged.</div>
      <h4 style="font-size:12px;color:var(--ink-3);margin:14px 0 6px">RE-CHECK</h4>
      <div class="note ${rs.flagged ? "warn" : ""}">${rs.status === "done" ? (rs.flagged ? "The detector still flags this passage. Review it yourself; the score is only a signal." : `No longer flagged by ${esc(rs.provider)} (${esc(rs.mode)}).`) : esc(rs.message || "Similarity fixes are confirmed on the next plagiarism scan.")}</div>
      <div class="actions"><button class="btn" id="undoLast" data-id="${e.id}">Undo</button><button class="btn ghost" id="backDetail">Done</button></div>`
      : `<div class="note warn">${esc(e.error)}</div><div class="actions"><button class="btn ghost" id="backDetail">Back</button></div>`}</div>`;
}
function renderHistory() {
  const r = S.report;
  const applied = r.edits.filter((e) => e.status === "applied");
  const lastId = applied.find((e) => e.to_version_id === r.version.id)?.id;
  return `<div class="detail hist"><h3>History</h3>
    <h4 style="font-size:12px;color:var(--ink-3);margin:12px 0 4px">VERSIONS</h4>
    ${r.versions.slice().reverse().map((v) => `<div class="row"><div class="d"><strong>v${v.number}</strong>${v.current ? ' <span class="state fixed">current</span>' : ""}<div class="note">${esc(v.note)} · ${new Date(v.created_at).toLocaleString()}</div></div><button class="btn small" data-dl="${v.id}">Download</button></div>`).join("")}
    <h4 style="font-size:12px;color:var(--ink-3);margin:16px 0 4px">EDITS</h4>
    ${r.edits.filter((e) => e.status !== "proposed").map((e) => `<div class="row"><div class="d"><span class="state ${e.status === "applied" ? "fixed" : ""}">${e.status}</span> ${esc(e.method)} · ${esc(e.element_id)}
      <div class="note">${esc((e.before || "").slice(0, 80))}${e.after ? " → " + esc(e.after.slice(0, 80)) : ""}</div>${e.error ? `<div class="note warn">${esc(e.error)}</div>` : ""}</div>
      ${e.id === lastId ? `<button class="btn small" data-undo="${e.id}">Undo</button>` : ""}</div>`).join("") || '<div class="note">No edits yet.</div>'}
    <div class="actions"><button class="btn ghost" id="backDetail">Close</button></div></div>`;
}

/* ---------------- word diff ---------------- */
function diffHtml(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  if (A.length * B.length > 400000) return esc(b);
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = "";
  while (i < n && j < m) {
    if (A[i] === B[j]) { out += esc(A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out += `<del>${esc(A[i])}</del>`; i++; }
    else { out += `<ins>${esc(B[j])}</ins>`; j++; }
  }
  while (i < n) out += `<del>${esc(A[i++])}</del>`;
  while (j < m) out += `<ins>${esc(B[j++])}</ins>`;
  return out;
}

/* ---------------- actions ---------------- */
function bindWS() {
  const r = S.report;
  $("#back").onclick = () => go("/");
  bindDownloads();
  app.querySelectorAll("#scanSeg button").forEach((b) => (b.onclick = () => startScan(b.dataset.k.split(","))));
  app.querySelectorAll("#scopeSeg button").forEach((b) => (b.onclick = () => { S.fixScope = b.dataset.s; renderWS(); }));
  $("#fixAll").onclick = () => fix({ level: "document", scope: S.fixScope });
  $("#settingsBtn").onclick = settingsModal;
  $("#histBtn").onclick = () => { S.right = "history"; refreshRight(); };
  app.querySelectorAll(".loc").forEach((el) => (el.onclick = () => {
    const loc = +el.dataset.loc; S.loc = S.loc === loc ? null : loc; renderWS();
    const page = app.querySelector(`.page[data-loc="${loc}"]`); page && page.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#locFix") && ($("#locFix").onclick = () => fix({ level: "page", location: S.loc, scope: S.fixScope }));
  $("#locClear") && ($("#locClear").onclick = () => { S.loc = null; renderWS(); });
  app.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; renderWS(); }));
  app.querySelectorAll(".finding").forEach((el) => (el.onclick = () => select(el.dataset.id, true)));
  $("#center").onclick = (e) => {
    const v = e.target.closest("[data-v]");
    if (v) { S.view = v.dataset.v; localStorage.setItem("verity_view", S.view); renderWS(); return; }
    const m = e.target.closest("mark"); if (m && m.dataset.f) select(m.dataset.f, false);
  };
  bindRight();
  if (S.view === "design") mountDesign();
}
function select(id, scroll) {
  S.sel = id; S.right = "detail";
  app.querySelectorAll(".finding").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  app.querySelectorAll("mark.sel").forEach((m) => m.classList.remove("sel"));
  const f = findingById(id);
  const design = app.querySelector("#designHost .design");
  if (S.view === "design" && design) {
    const ok = P.setSelected(design, id, scroll);
    if (!ok && scroll && f) { P.scrollToLocation(design, S.report.document.format, f.location); toast("This passage could not be placed exactly on the design view. It is shown in the right panel and in Text view."); }
    refreshRight();
    return;
  }
  const para = f && app.querySelector(`.para[data-el="${CSS.escape(f.element_id)}"]`);
  if (para) {
    const fs = F().filter((x) => x.element_id === f.element_id && x.state !== "stale");
    para.innerHTML = renderPara(S.report.elements.find((e) => e.id === f.element_id), fs);
    const mk = para.querySelector(`mark[data-f="${id}"]`);
    if (scroll && mk) { mk.scrollIntoView({ behavior: "smooth", block: "center" }); mk.classList.add("pulse"); }
  }
  refreshRight();
}
function refreshRight() { $("#right").innerHTML = renderRight(); bindRight(); bindDownloads(); }
function bindDownloads() {
  app.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => guarded(() => D.download(S.report.document, S.report.versions.find((v) => v.id === b.dataset.dl)))));
}
function bindRight() {
  const on = (id, fn) => { const el = $("#" + id); if (el) el.onclick = fn; };
  app.querySelectorAll("[data-o]").forEach((s) => (s.onchange = () => { S.opts[s.dataset.o] = s.value; saveOpts(); }));
  const f = S.sel && findingById(S.sel);
  on("aiFix", () => fix({ finding_ids: [f.id], level: "passage", scope: f.type }));
  on("paraFix", () => fix({ finding_ids: [f.id], level: "paragraph", scope: "both" }));
  on("manualBtn", () => manualStart(f));
  on("reviewBtn", async () => { await guarded(() => D.markReviewed(f.id)); toast("Marked as reviewed"); openDoc(S.docId, true); });
  on("backDetail", () => { S.right = "detail"; refreshRight(); });
  on("regen", async () => {
    if (!S.proposal) return;
    const req = S.proposal._req;
    if (S.proposal.status === "proposed") await D.reject([S.proposal.id]);
    fix(req);
  });
  on("rejectBtn", async () => { await guarded(() => D.reject([S.proposal.id])); S.right = "detail"; S.proposal = null; refreshRight(); toast("Proposal rejected. Your document is unchanged."); });
  on("propEditBtn", () => $("#propEdit").classList.toggle("hidden"));
  on("propSave", async () => {
    const e = await guarded(() => D.updateProposal(S.proposal, $("#propText").value));
    if (e) { e._req = S.proposal._req; S.proposal = e; refreshRight(); }
  });
  on("accept", () => acceptEdits([S.proposal.id]));
  on("manSave", async () => {
    const m = S.manual;
    $("#manSave").innerHTML = '<span class="spin"></span> Saving...';
    const e = await guarded(async () => { const ed = await D.createManual(S.report, m, $("#manText").value); return (await D.applyEdits(S.docId, [ed.id]))[0]; });
    if (e) { S.lastResult = e; S.right = "result"; await openDoc(S.docId, true); } else refreshRight();
  });
  on("undoLast", () => undoEdit($("#undoLast").dataset.id));
  app.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = () => undoEdit(b.dataset.undo)));
}
async function startScan(kinds) {
  toast(`Scanning: ${kinds.join(" + ")}. AI detection takes a few seconds.`);
  app.querySelectorAll("#scanSeg button").forEach((b) => (b.disabled = true));
  const res = await guarded(() => D.startScan(S.docId, kinds));
  if (res) { const err = res.find((x) => x.status === "error"); if (err) toast(`${err.kind} scan: ${err.message}`, true); S.me = await D.me(); $("#credits").textContent = `${S.me.credits} credits`; }
  openDoc(S.docId, true);
}
async function fix(req) {
  if (S.busy) return;
  S.busy = true;
  const body = { ...req, mode: S.opts.mode, writing_level: S.opts.writing_level, citation_style: S.opts.citation_style, plag_action: S.opts.plag_action };
  const btns = app.querySelectorAll("#aiFix,#paraFix,#fixAll,#locFix,#regen");
  btns.forEach((b) => { b.disabled = true; });
  const label = $("#right");
  if (req.level === "passage" || req.level === "paragraph") label.innerHTML = `<div class="empty"><span class="spin"></span> Writing a proposal...</div>`;
  else toast("Preparing proposals for every flagged passage. This can take a minute.");
  const edits = await guarded(() => D.propose(S.report, body, (n, t) => { if (t > 1) toast(`Writing proposal ${n} of ${t}...`); }));
  S.busy = false;
  btns.forEach((b) => { b.disabled = false; });
  if (!edits) { refreshRight(); return; }
  edits.forEach((e) => (e._req = req));
  if (edits.length === 1 && (req.level === "passage" || req.level === "paragraph")) { S.proposal = edits[0]; S.right = "proposal"; refreshRight(); }
  else queueModal(edits);
}
async function manualStart(f) {
  const t = await guarded(() => D.manualTemplate(S.report, f.element_id, f.start, f.end));
  if (!t) return;
  S.manual = { ...t, finding_ids: [f.id] }; S.right = "manual"; refreshRight();
}
async function acceptEdits(ids) {
  const out = await guarded(() => D.applyEdits(S.docId, ids, (n, t) => { if (t > 1) toast(`Applying and verifying change ${n} of ${t}...`); }));
  if (!out) return;
  const ok = out.filter((e) => e.status === "applied").length, bad = out.filter((e) => e.status !== "applied");
  if (out.length === 1) { S.lastResult = out[0]; S.right = "result"; }
  else { S.right = "detail"; toast(`${ok} change${ok === 1 ? "" : "s"} applied${bad.length ? `, ${bad.length} not applied (see History)` : ""}.`, bad.length > 0); }
  S.proposal = null;
  await openDoc(S.docId, true);
}
async function undoEdit(id) {
  const e = await guarded(() => D.undo(S.docId, id));
  if (e) { toast("Undone. The previous version is current again."); S.right = "detail"; S.lastResult = null; openDoc(S.docId, true); }
}

/* ---------------- modals ---------------- */
function modal(html) {
  const o = document.createElement("div");
  o.className = "overlay"; o.innerHTML = `<div class="modal">${html}</div>`;
  o.onclick = (e) => { if (e.target === o) o.remove(); };
  document.body.appendChild(o);
  return o;
}
function queueModal(edits) {
  const ready = edits.filter((e) => e.status === "proposed"), failed = edits.filter((e) => e.status === "failed");
  const o = modal(`<header><h3>Review ${ready.length} proposed change${ready.length === 1 ? "" : "s"}</h3><div class="spacer"></div><label class="note"><input type="checkbox" id="qAll" checked> Select all</label></header>
    <div class="body">
      ${failed.length ? `<div class="note warn" style="margin-top:12px">${failed.length} passage${failed.length === 1 ? "" : "s"} could not get a safe proposal: ${failed.map((f) => esc(f.error)).join("; ")}</div>` : ""}
      ${ready.map((e) => `<div class="qitem"><div class="qh"><input type="checkbox" class="qc" data-id="${e.id}" checked> ${esc(e.element_id)} · ${esc(e.scope)} · ${esc(e.provider)}</div>
        <div class="qb"><div>${esc(e.before)}</div><div class="diff">${diffHtml(e.before, e.after)}</div></div><div class="qx">${esc(e.explanation)}</div></div>`).join("") || '<div class="empty">No proposals to review.</div>'}
    </div>
    <footer><span class="note">Each accepted change is applied on its own and verified. A failure never affects the others.</span><div class="spacer"></div><button class="btn ghost" id="qReject">Reject all</button><button class="btn primary" id="qAccept">Accept selected</button></footer>`);
  $("#qAll", o).onchange = (e) => o.querySelectorAll(".qc").forEach((c) => (c.checked = e.target.checked));
  $("#qAccept", o).onclick = async () => {
    const ids = [...o.querySelectorAll(".qc")].filter((c) => c.checked).map((c) => c.dataset.id);
    const rej = [...o.querySelectorAll(".qc")].filter((c) => !c.checked).map((c) => c.dataset.id);
    $("#qAccept", o).innerHTML = '<span class="spin"></span> Applying...';
    if (rej.length) await D.reject(rej);
    o.remove();
    if (ids.length) acceptEdits(ids);
  };
  $("#qReject", o).onclick = async () => { await D.reject(ready.map((e) => e.id)); o.remove(); toast("All proposals rejected. Your document is unchanged."); };
}
function settingsModal() {
  const o = modal(`<header><h3>Fix settings</h3></header><div class="body">${optsForm()}<div class="note">Used for every AI fix. Rewrites keep your meaning, terminology and citations, never invent sources, and are re-checked once after you accept.</div></div>
    <footer><div class="spacer"></div><button class="btn primary" id="sDone">Done</button></footer>`);
  o.querySelectorAll("[data-o]").forEach((s) => (s.onchange = () => { S.opts[s.dataset.o] = s.value; saveOpts(); }));
  $("#sDone", o).onclick = () => { o.remove(); if (S.right === "detail") refreshRight(); };
}
function askConsent() {
  return new Promise((resolve) => {
    const o = modal(`<header><h3>Send text to external AI providers?</h3></header><div class="body">
      <p class="note" style="font-size:13.5px">To analyse and fix your document, Verity sends its text to <strong>${esc(S.status.detector || "the detection provider")}</strong> (AI and plagiarism detection) and <strong>Anthropic Claude</strong> (rewrites). They process it under their API terms. Verity does not use your documents to train models. You can delete a document and its versions at any time.</p></div>
      <footer><div class="spacer"></div><button class="btn ghost" id="cNo">Cancel</button><button class="btn primary" id="cYes">I agree</button></footer>`);
    $("#cNo", o).onclick = () => { o.remove(); resolve(false); };
    $("#cYes", o).onclick = async () => { await D.giveConsent(); S.me.consent_external_ai = true; o.remove(); resolve(true); };
  });
}

boot();
