/* Verity AI web app. Plain JS modules, hosted on GitHub Pages, data in Supabase. */
import * as D from "./data.js";
import * as P from "./preview.js";
const S = {
  me: null, status: null, report: null, docId: null,
  filter: "all", loc: null, sel: null, right: "detail", proposal: null, manual: null, lastResult: null,
  fixScope: "both", autoScan: null, newTab: "file", scanKinds: { ai: true, plagiarism: true },
  view: localStorage.getItem("verity_view") || "design",
  opts: JSON.parse(localStorage.getItem("verity_opts") || "null") || { mode: "clarity", writing_level: "postgraduate", citation_style: "APA 7", plag_action: "paraphrase" },
  poll: null, busy: false,
};
const $ = (s, r = document) => r.querySelector(s);
const root = $("#root");
let app = root;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);
const TYPE_LABEL = { ai: "AI writing", identical: "Identical", minor_changes: "Minor changes", paraphrased: "Paraphrased" };
const STATE_LABEL = { open: "Open", fixed: "Fixed", fixed_pending: "Fixed, awaiting re-check", reviewed: "Reviewed", stale: "Needs re-scan" };
const SUPPORT_EMAIL = "raheelgul063@gmail.com";
const WORDS_PER_CREDIT = 250;

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

/* ---------------- icons (inline, stroke) ---------------- */
const I = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  plans: '<path d="M3 7h18v10H3z"/><path d="M3 11h18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
  out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  text: '<path d="M5 6h14M5 11h14M5 16h9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
const icon = (n, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;

/* ---------------- charts ---------------- */
function donut(segs, center, sub, size = 96) {
  const r = 38, c = 2 * Math.PI * r;
  let off = 0;
  const arcs = segs.filter((s) => s.v > 0).map((s) => {
    const len = Math.min(1, s.v) * c;
    const el = `<circle r="${r}" cx="50" cy="50" fill="none" stroke="${s.c}" stroke-width="12" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 50 50)"/>`;
    off += len;
    return el;
  }).join("");
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="${esc(center)} ${esc(sub || "")}">
    <circle r="${r}" cx="50" cy="50" fill="none" stroke="var(--line-2)" stroke-width="12"/>${arcs}
    <text x="50" y="${sub ? 50 : 55}" text-anchor="middle" font-size="19" font-weight="700" fill="var(--ink)">${esc(center)}</text>
    ${sub ? `<text x="50" y="65" text-anchor="middle" font-size="9.5" fill="var(--ink-3)">${esc(sub)}</text>` : ""}</svg>`;
}
const C = { ai: "#7b4bd6", identical: "#d23b3b", minor: "#e07b1f", para: "#c49a00", ok: "#1d8a55" };
function scoreChip(v, kind) {
  if (v === null || v === undefined) return '<span class="mini none">not scanned</span>';
  if (v === "sample") return '<span class="mini none">sample</span>';
  const p = Math.round(v), col = kind === "ai" ? C.ai : C.identical;
  return `<span class="mini"><span class="minibar"><i style="width:${Math.max(2, p)}%;background:${col}"></i></span>${p}%</span>`;
}

/* ---------------- boot & routing ---------------- */
async function boot() {
  S.status = await D.status();
  try { S.me = await D.me(); } catch { S.me = null; }
  D.sb.auth.onAuthStateChange(async (ev) => { if (ev === "SIGNED_IN" && !S.me) { S.me = await D.me(); route(); } });
  route();
}
window.addEventListener("hashchange", route);
function go(path) { if (location.hash === "#" + path) route(); else location.hash = path; }
function page() {
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/doc\/([a-f0-9-]+)/);
  if (m) return { name: "doc", id: m[1] };
  return { name: { "/": "new", "/scans": "scans", "/plans": "plans", "/profile": "profile", "/support": "support" }[h] || "new" };
}
function route() {
  clearTimeout(S.poll);
  if (!S.me) return renderAuth();
  const p = page();
  shell(p.name);
  if (p.name === "doc") return openDoc(p.id);
  ({ new: renderNew, scans: renderScans, plans: renderPlans, profile: renderProfile, support: renderSupport })[p.name]();
}

/* ---------------- shell ---------------- */
function initials() {
  const n = (S.me.full_name || S.me.email || "?").trim();
  const parts = n.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}
function shell(active) {
  if (!$("#shell")) root.innerHTML = `<div class="shell" id="shell"><aside class="side" id="side"></aside><main class="main" id="main"></main></div>`;
  $("#shell").classList.toggle("rail", active === "doc");
  const st = S.status || {};
  const credits = S.me.credits ?? 0;
  const nav = [["new", "/", "plus", "New scan"], ["scans", "/scans", "files", "My documents"], ["plans", "/plans", "plans", "Plans & credits"], ["profile", "/profile", "user", "Profile"], ["support", "/support", "help", "Support"]];
  $("#side").innerHTML = `
    <div class="brandrow"><a class="brand" href="#/"><span class="logo">V</span><span class="lbl">Verity AI</span></a>
      <button class="iconbtn railtoggle" id="railToggle" title="Expand or collapse the menu">${icon("menu")}</button></div>
    <nav class="nav">${nav.map(([k, h, ic, l]) => `<a href="#${h}" class="${active === k || (k === "scans" && active === "doc") ? "on" : ""}" title="${l}">${icon(ic)}<span class="lbl">${l}</span></a>`).join("")}</nav>
    <div class="spacer"></div>
    <div class="creditcard lbl-block">
      <div class="k">Credits</div>
      <div class="v">${credits}</div>
      <div class="bar"><i style="width:${Math.min(100, (credits / ({ student: 80, pro: 220 }[S.me.plan] || 25)) * 100)}%"></i></div>
      <div class="s">AI check: 1 credit per ${WORDS_PER_CREDIT} words</div>
      <a href="#/plans" class="btn small">Get more credits</a>
    </div>
    <div class="provs lbl-block">
      <span class="dot ${st.copyleaks === "live" ? "live" : st.copyleaks === "sandbox" ? "warn" : ""}"></span>${esc(st.copyleaks === "sample" ? "Detector: sample mode" : `${st.detector || "Detector"}: ${st.copyleaks}`)}<br>
      <span class="dot ${st.claude === "live" ? "live" : ""}"></span>${st.claude === "live" ? "Claude rewrites: live" : "Claude: sample mode"}
    </div>
    <div class="userrow"><a href="#/profile" class="avatar" title="Profile">${esc(initials())}</a>
      <div class="lbl who"><div class="n">${esc(S.me.full_name || "Your account")}</div><div class="e">${esc(S.me.email)}</div></div>
      <button class="iconbtn lbl" id="logout" title="Log out">${icon("out")}</button></div>`;
  $("#logout") && ($("#logout").onclick = async () => { await D.signOut(); S.me = null; root.innerHTML = ""; go("/"); });
  $("#railToggle").onclick = () => $("#shell").classList.toggle("rail");
  app = $("#main");
}
function refreshSide() { shell(page().name); }

/* ---------------- auth ---------------- */
function renderAuth(mode = "login") {
  app = root;
  root.innerHTML = `<div class="authwrap">
    <section class="authbrand">
      <div class="brand"><span class="logo">V</span>Verity AI</div>
      <h1>Check your work. Fix only what is flagged.</h1>
      <ul>
        <li><strong>AI writing and plagiarism report</strong> with sources, scores and the exact passages.</li>
        <li><strong>One-click fixes</strong> inside your Word or PowerPoint file. Citations, links and formatting stay intact.</li>
        <li><strong>Every other paragraph and slide stays byte for byte the same,</strong> and every change can be undone.</li>
      </ul>
      <p class="fine">AI detection is a signal, not proof. Verity helps you review and improve your own writing.</p>
    </section>
    <section class="authform">
      <h2>${mode === "login" ? "Welcome back" : "Create your account"}</h2>
      <p class="note">${mode === "login" ? "Log in to see your documents and reports." : "Free account with 25 credits to try it."}</p>
      <div class="field"><label>Email</label><input id="em" type="email" autocomplete="email"></div>
      <div class="field"><label>Password (8+ characters)</label><input id="pw" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}"></div>
      <div class="err" id="aerr"></div>
      <button class="btn primary big" id="go">${mode === "login" ? "Log in" : "Create account"}</button>
      <p class="switch">${mode === "login" ? 'No account? <a href="#" id="sw">Create one</a>' : 'Have an account? <a href="#" id="sw">Log in</a>'}</p>
    </section></div>`;
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
      root.innerHTML = "";
      route();
    } catch (e) { $("#aerr").textContent = e.message; }
  };
  $("#go").onclick = submit;
  $("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

/* ---------------- shared page bits ---------------- */
const pageHead = (title, sub, right = "") => `<header class="phead"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="pactions">${right}</div></header>`;
function docRow(d) {
  return `<tr class="row" data-id="${d.id}">
    <td><div class="docname"><span class="fmt ${d.format}">${d.format.toUpperCase()}</span><div><div class="t">${esc(d.name)}</div><div class="note">${d.stats.words.toLocaleString()} words · ${d.stats.locations} ${d.stats.location_label}${d.stats.locations === 1 ? "" : "s"} · v${d.version}</div></div></div></td>
    <td>${scoreChip(d.ai, "ai")}</td><td>${scoreChip(d.sim, "sim")}</td>
    <td>${d.open_findings ? `<span class="pill warn">${d.open_findings} open</span>` : d.scanned ? '<span class="pill ok">clear</span>' : '<span class="pill">not scanned</span>'}</td>
    <td class="note">${new Date(d.created_at).toLocaleDateString()}</td>
    <td class="acts"><button class="btn ghost small" data-del="${d.id}" title="Delete document and all versions">Delete</button></td></tr>`;
}
function bindDocRows(after) {
  app.querySelectorAll("tr.row").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("[data-del]")) go(`/doc/${tr.dataset.id}`); }));
  app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this document and every version? This cannot be undone.")) return;
    await guarded(() => D.deleteDoc(b.dataset.del)); toast("Document deleted."); after();
  }));
}
const docTable = (docs) => `<table class="list"><thead><tr><th>Document</th><th>AI content</th><th>Similarity</th><th>Status</th><th>Uploaded</th><th></th></tr></thead><tbody>${docs.map(docRow).join("")}</tbody></table>`;

/* ---------------- new scan ---------------- */
async function renderNew() {
  const kinds = S.scanKinds;
  app.innerHTML = `<div class="pg">
    ${pageHead("New scan", "Upload a Word or PowerPoint file, or paste text. You get an AI-writing and plagiarism report, then fix only what is flagged.")}
    <section class="card scanbox">
      <div class="tabs2">
        <button data-t="file" class="${S.newTab === "file" ? "on" : ""}">${icon("upload", 16)} Upload file</button>
        <button data-t="text" class="${S.newTab === "text" ? "on" : ""}">${icon("text", 16)} Paste text</button>
      </div>
      <div id="newBody">${S.newTab === "file" ? `
        <div class="drop" id="drop">${icon("upload", 34)}<strong>Drop a .docx or .pptx here</strong><span>or click to choose a file · up to 25 MB</span>
          <input type="file" id="file" accept=".docx,.pptx" class="hidden"></div>
        <p class="note center">Your original file is never changed. Every fix creates a new version you can download or undo. No file at hand? Try <a href="samples/sample-thesis.docx" download>a sample thesis</a> or <a href="samples/sample-deck.pptx" download>a sample deck</a>.</p>` : `
        <div class="field"><label>Title</label><input id="ptitle" placeholder="e.g. Essay draft, Chapter 2" maxlength="80"></div>
        <div class="field"><label>Text</label><textarea id="ptext" class="paste" placeholder="Paste your text here (at least 60 words for a reliable AI check)"></textarea></div>
        <div class="pastefoot"><span class="note" id="pcount">0 words</span><button class="btn primary" id="pgo">Scan text</button></div>
        <p class="note">Pasted text is saved as a Word document, so you can fix it with the same tools and download or copy the result.</p>`}
      </div>
      <div class="scanopts">
        <span class="note">Check for:</span>
        <label class="check"><input type="checkbox" id="kAi" ${kinds.ai ? "checked" : ""}> AI writing</label>
        <label class="check"><input type="checkbox" id="kPl" ${kinds.plagiarism ? "checked" : ""}> Plagiarism</label>
        <span class="note" id="costNote">Cost per ${WORDS_PER_CREDIT} words: AI 1 credit, plagiarism 2 credits</span>
      </div>
    </section>
    <section class="recent"><div class="sechead"><h2>Recent scans</h2><a href="#/scans">View all</a></div><div id="recentBody"><div class="empty"><span class="spin"></span></div></div></section>
  </div>`;
  app.querySelectorAll(".tabs2 button").forEach((b) => (b.onclick = () => { S.newTab = b.dataset.t; renderNew(); }));
  $("#kAi").onchange = (e) => (S.scanKinds.ai = e.target.checked);
  $("#kPl").onchange = (e) => (S.scanKinds.plagiarism = e.target.checked);
  if (S.newTab === "file") {
    const drop = $("#drop"), file = $("#file");
    drop.onclick = () => file.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) doUpload(e.dataTransfer.files[0]); };
    file.onchange = () => file.files[0] && doUpload(file.files[0]);
  } else {
    const t = $("#ptext"), count = () => { const n = t.value.split(/\s+/).filter(Boolean).length; const u = Math.max(1, Math.ceil(n / WORDS_PER_CREDIT)); $("#pcount").textContent = `${n.toLocaleString()} words · ${u * ((S.scanKinds.ai ? 1 : 0) + (S.scanKinds.plagiarism ? 2 : 0))} credits with the checks selected`; };
    t.oninput = count;
    $("#pgo").onclick = async () => {
      const text = t.value.trim();
      if (text.split(/\s+/).length < 20) return toast("Paste at least 20 words.", true);
      $("#pgo").innerHTML = '<span class="spin"></span> Preparing...';
      const file = await D.textToDocx($("#ptitle").value.trim() || "Pasted text", text);
      doUpload(file);
    };
  }
  const docs = await guarded(() => D.listDocs()) || [];
  const rb = $("#recentBody");
  if (!rb) return;
  rb.innerHTML = docs.length ? docTable(docs.slice(0, 5)) : '<div class="empty">Nothing scanned yet. Your documents will appear here.</div>';
  bindDocRows(renderNew);
}
async function doUpload(f) {
  const drop = $("#drop");
  if (drop) drop.innerHTML = `<span class="spin"></span> Uploading and reading ${esc(f.name)}...`;
  const d = await guarded(() => D.upload(f));
  if (!d) return renderNew();
  const kinds = Object.entries(S.scanKinds).filter(([, v]) => v).map(([k]) => k);
  S.autoScan = kinds.length ? kinds : null;
  go(`/doc/${d.id}`);
}

/* ---------------- my documents ---------------- */
async function renderScans() {
  app.innerHTML = `<div class="pg">${pageHead("My documents", "Every file you have checked, with its latest scores.", `<a class="btn primary" href="#/">${icon("plus", 16)} New scan</a>`)}
    <div class="toolbar"><input id="q" class="search" placeholder="Search documents"></div>
    <div id="docsBody"><div class="empty"><span class="spin"></span></div></div></div>`;
  const docs = await guarded(() => D.listDocs()) || [];
  const draw = () => {
    const q = ($("#q").value || "").toLowerCase();
    const list = docs.filter((d) => d.name.toLowerCase().includes(q));
    $("#docsBody").innerHTML = list.length ? docTable(list) : `<div class="empty">${docs.length ? "No documents match your search." : 'No documents yet. <a href="#/">Start a new scan</a>.'}</div>`;
    bindDocRows(renderScans);
  };
  $("#q").oninput = draw;
  draw();
}

/* ---------------- profile ---------------- */
async function renderProfile() {
  app.innerHTML = `<div class="pg"><div class="empty"><span class="spin"></span></div></div>`;
  const [usage, docs] = await Promise.all([guarded(() => D.usage()), guarded(() => D.listDocs())]);
  const me = S.me;
  const scansDone = (usage || []).filter((u) => u.action.startsWith("scan")).length;
  const levels = ["", "Bachelor", "Master", "PhD / doctoral", "School", "Professional", "Other"];
  app.innerHTML = `<div class="pg">${pageHead("Profile", "Your details, credits and activity.")}
    <div class="grid2">
      <section class="card">
        <div class="profhead"><span class="avatar big">${esc(initials())}</span><div><h3>${esc(me.full_name || "Add your name")}</h3><div class="note">${esc(me.email)} · member since ${new Date(me.created_at).toLocaleDateString()}</div></div></div>
        <div class="formgrid">
          <div class="field"><label>Full name</label><input id="fName" value="${esc(me.full_name)}" maxlength="120"></div>
          <div class="field"><label>University or school</label><input id="fUni" value="${esc(me.university)}" maxlength="160"></div>
          <div class="field"><label>Study level</label><select id="fLevel">${levels.map((l) => `<option ${me.study_level === l ? "selected" : ""} value="${esc(l)}">${l || "Choose"}</option>`).join("")}</select></div>
          <div class="field"><label>Country</label><input id="fCountry" value="${esc(me.country)}" maxlength="80"></div>
        </div>
        <button class="btn primary" id="saveProf">Save details</button>
      </section>
      <section class="card">
        <h3>Plan and credits</h3>
        <div class="statrow"><div><div class="k">Plan</div><div class="v">${esc((me.plan || "free").replace(/^./, (c) => c.toUpperCase()))}</div></div>
          <div><div class="k">Credits left</div><div class="v">${me.credits}</div></div>
          <div><div class="k">Documents</div><div class="v">${(docs || []).length}</div></div>
          <div><div class="k">Scans run</div><div class="v">${scansDone}</div></div></div>
        <a href="#/plans" class="btn">See plans</a>
        <h3 class="mt">Privacy</h3>
        <p class="note">${me.consent_external_ai ? "You agreed that document text may be sent to the detection provider and Anthropic Claude for analysis and rewrites." : "You have not yet agreed to send text to external providers. You will be asked before your first scan."} Your documents are never used to train models.</p>
      </section>
      <section class="card">
        <h3>Change password</h3>
        <div class="field"><label>New password (8+ characters)</label><input id="np" type="password" autocomplete="new-password"></div>
        <button class="btn" id="savePw">Update password</button>
      </section>
      <section class="card">
        <h3>Recent activity</h3>
        ${(usage || []).length ? `<table class="list compact"><thead><tr><th>When</th><th>What</th><th>Words</th><th>Credits</th></tr></thead><tbody>
          ${usage.slice(0, 12).map((u) => `<tr><td class="note">${new Date(u.created_at).toLocaleString()}</td><td>${esc(u.action.replace("scan:", "Scan: ").replace("refund:failed-scan", "Refund (failed check)").replace("rewrite", "AI rewrite").replace("+", " + "))}</td><td>${u.words ? u.words.toLocaleString() : ""}</td><td>${u.credits ? (u.credits > 0 ? "-" + u.credits : "+" + -u.credits) : ""}</td></tr>`).join("")}
        </tbody></table>` : '<p class="note">No activity yet.</p>'}
      </section>
      <section class="card danger">
        <h3>Delete my documents</h3>
        <p class="note">Removes every document, version and report from Verity. Your account stays. This cannot be undone.</p>
        <button class="btn" id="delAll">Delete all documents</button>
      </section>
    </div></div>`;
  $("#saveProf").onclick = async () => {
    const ok = await guarded(() => D.updateProfile({ full_name: $("#fName").value.trim(), university: $("#fUni").value.trim(), study_level: $("#fLevel").value, country: $("#fCountry").value.trim() }));
    if (ok !== undefined) { S.me = await D.me(); toast("Details saved."); refreshSide(); renderProfile(); }
  };
  $("#savePw").onclick = async () => {
    const pw = $("#np").value;
    if (pw.length < 8) return toast("Use at least 8 characters.", true);
    const ok = await guarded(() => D.changePassword(pw));
    if (ok !== undefined) { $("#np").value = ""; toast("Password updated."); }
  };
  $("#delAll").onclick = async () => {
    if (!confirm("Delete ALL your documents, versions and reports? This cannot be undone.")) return;
    for (const d of docs || []) await guarded(() => D.deleteDoc(d.id));
    toast("All documents deleted."); renderProfile();
  };
}

/* ---------------- plans ---------------- */
function renderPlans() {
  const mail = (plan) => `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Verity ${plan} plan`)}&body=${encodeURIComponent(`Hi, I would like the ${plan} plan for ${S.me.email}.`)}`;
  const plans = [
    { name: "Free", price: "€0", per: "", credits: "25 credits to try", words: "about 6,000 words of AI checks", items: ["AI writing report", "Plagiarism report with sources", "Fix with AI and manual edits", "Download every version"], cta: `<span class="btn" disabled>${(S.me.plan || "free") === "free" ? "Your current plan" : "Free"}</span>` },
    { name: "Student", price: "€4.99", per: "/ month", credits: "80 credits every month", words: "about 20,000 words of AI checks, or 6,600 words with AI + plagiarism", items: ["Everything in Free", "Monthly credit refill", "Priority processing", "Email support"], cta: `<a class="btn primary" href="${mail("Student")}">Request Student plan</a>`, hl: true },
    { name: "Pro", price: "€12.99", per: "/ month", credits: "220 credits every month", words: "about 55,000 words of AI checks, or 18,000 words with AI + plagiarism", items: ["Everything in Student", "Large theses and decks", "Bulk fixes across documents", "Faster support"], cta: `<a class="btn" href="${mail("Pro")}">Request Pro plan</a>` },
  ];
  app.innerHTML = `<div class="pg">${pageHead("Plans & credits", "Pay for what you check. Per 250 words: AI check 1 credit, plagiarism check 2 credits. Fixes are free.")}
    <div class="plans">${plans.map((p) => `<section class="card plan ${p.hl ? "hl" : ""}">
      ${p.hl ? '<span class="tag">Most popular</span>' : ""}
      <h3>${p.name}</h3><div class="price">${p.price}<span>${p.per}</span></div>
      <div class="cred">${p.credits}</div><div class="note">${p.words}</div>
      <ul>${p.items.map((i) => `<li>${i}</li>`).join("")}</ul>${p.cta}</section>`).join("")}</div>
    <section class="card">
      <h3>How credits work</h3>
      <div class="statrow"><div><div class="k">AI check, 2,500-word essay</div><div class="v">10 credits</div></div>
        <div><div class="k">AI + plagiarism, same essay</div><div class="v">30 credits</div></div>
        <div><div class="k">Fix with AI</div><div class="v">free</div></div>
        <div><div class="k">Failed check</div><div class="v">refunded</div></div></div>
      <p class="note">Online payment is being set up. Until then, request a plan by email and it is activated on your account by hand.</p>
    </section></div>`;
}

/* ---------------- support ---------------- */
function renderSupport() {
  const faq = [
    ["Is an AI score proof that I used AI?", "No. AI detection is probabilistic. Formal, technical, translated and non-native writing is often flagged wrongly. Use the report to review your text, not as a verdict."],
    ["Does Verity change anything else in my file?", "No. A fix replaces only the selected passage. Before saving, Verity checks that every other paragraph, slide, image, table, header and footer is unchanged, and refuses the edit if not. Every change is a new version you can undo."],
    ["Are my citations kept?", "Yes. Citations (including Zotero, Mendeley and EndNote fields), links, direct quotes and bold or italic terms are protected and put back exactly as they were."],
    ["What does plagiarism mean here?", "Similarity with sources on the web. Quoted and cited material and common phrases can also match. For each match you see the source and whether a quote or citation is nearby."],
    ["Which files work?", "Word (.docx) and PowerPoint (.pptx), up to 25 MB, or pasted text. For a PDF, save it as .docx first."],
    ["Who sees my documents?", "Only you. Text is sent to the detection provider and to Anthropic Claude to run checks and rewrites, and is never used to train models. You can delete documents at any time from your profile."],
    ["How do credits work?", "Per 250 words, an AI check costs 1 credit and a plagiarism check costs 2 credits. Fixes are free. If a check fails, its credits are refunded automatically."],
  ];
  app.innerHTML = `<div class="pg">${pageHead("Support", "Answers to common questions, and how to reach us.")}
    <div class="grid2 wide">
      <section class="card faq">${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>
      <section class="card"><h3>Contact</h3><p class="note">Questions, a bug, or a plan request? Email us and include the document name if it is about a report.</p>
        <a class="btn primary" href="mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Verity support")}">Email support</a>
        <h3 class="mt">Status</h3><p class="note">Detection: ${esc(S.status?.detector || "sample mode")} (${esc(S.status?.copyleaks || "sample")})<br>Rewrites: Claude (${esc(S.status?.claude || "sample")})</p></section>
    </div></div>`;
}

/* ---------------- workspace ---------------- */
async function openDoc(id, keep) {
  if (S.docId !== id) { S.sel = null; S.right = "detail"; S.loc = null; S.filter = "all"; S.proposal = null; S.lastResult = null; }
  S.docId = id;
  const rep = await guarded(() => D.report(id));
  if (!rep) return;
  S.report = rep;
  renderWS();
  if (S.autoScan) { const k = S.autoScan; S.autoScan = null; return startScan(k); }
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
      <button class="btn ghost small" id="back">My documents</button>
      <span class="title" title="${esc(r.document.name)}">${esc(r.document.name)}</span>
      <span class="badge">v${r.version.number}</span>
      <span class="badge">${st.words.toLocaleString()} words</span>
      <span class="badge">${st.locations} ${st.location_label}s${r.document.format === "docx" ? " (approx.)" : ""}</span>
      <span class="badge">${esc(st.language).toUpperCase()}</span>
      <div class="spacer"></div>
      <button class="btn" id="histBtn">History</button>
      <button class="btn" id="copyText" title="Copy the current text of the document">Copy text</button>
      <button class="btn" data-dl="${r.version.id}">Download v${r.version.number}</button>
    </div>
    <div class="ws-tools">
      <span class="note">Scan</span>
      <div class="seg" id="scanSeg"><button data-k="ai,plagiarism">Scan AI + plagiarism</button><button data-k="ai">AI only</button><button data-k="plagiarism">Plagiarism only</button></div>
      <span class="vsep"></span><span class="note">Fix</span>
      <div class="seg" id="scopeSeg">${["ai", "plagiarism", "both"].map((s) => `<button data-s="${s}" class="${S.fixScope === s ? "on" : ""}">${s === "ai" ? "AI" : s === "plagiarism" ? "Plagiarism" : "Both"}</button>`).join("")}</div>
      <button class="btn accent" id="fixAll">Fix all with AI</button>
      <button class="btn" id="settingsBtn">Fix settings</button>
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
  const lab = r.version.stats.location_label === "slide" ? "Slide" : "Page";
  const scanState = (s) => !s ? "Not scanned yet" : s.status === "done" ? (s.mode === "sample" ? "Sample data, no API key" : `${esc(s.provider)}${s.mode === "live" ? "" : " (" + s.mode + ")"}`) : s.status === "error" ? `<span class="errtxt">${esc(s.message).slice(0, 140)}</span>` : `<span class="spin"></span> ${esc(s.status)}${s.message ? ": " + esc(s.message) : ""}`;
  const aiDone = ai && ai.status === "done" && ai.mode !== "sample" && ai.summary?.ai_share != null;
  const aiShare = aiDone ? ai.summary.ai_share : null;
  const pls = pl?.summary || {};
  const plDone = pl && pl.status === "done" && pl.mode !== "sample";
  const simTotal = plDone ? (pls.aggregated ?? (pls.identical || 0) + (pls.minor_changes || 0) + (pls.paraphrased || 0)) : null;
  const scanned = Math.max(ai?.words || 0, pl?.words || 0);
  const cov = scanned ? Math.min(100, Math.round((100 * scanned) / r.version.stats.words)) : null;
  const aiOpen = open.filter((f) => f.type === "ai"), plOpen = open.filter((f) => f.type === "plagiarism");
  const key = open.slice().sort((x, y) => sev(y) - sev(x)).slice(0, 3);
  function sev(f) { return f.type === "plagiarism" ? ({ identical: 2, minor_changes: 1.6, paraphrased: 1.3 }[f.match_type] || 1.5) + (needsCitation(f) ? 0.5 : 0) : (f.score ?? 0.5) * 2; }
  return `<div class="sumcards">
    <div class="sc donutcard">${donut(aiDone ? [{ v: aiShare, c: C.ai }] : [], aiDone ? `${Math.round(aiShare * 100)}%` : ai?.mode === "sample" ? "Sample" : "n/a", "AI")}
      <div><div class="k">AI content</div><div class="s">${scanState(ai)}</div>
      <div class="legend"><span><i style="background:${C.ai}"></i>${aiOpen.length} passage${aiOpen.length === 1 ? "" : "s"} flagged</span>${aiDone ? `<span><i style="background:var(--line)"></i>${Math.round((1 - aiShare) * 100)}% likely human</span>` : ""}</div></div></div>
    <div class="sc donutcard">${donut(plDone ? [{ v: (pls.identical || 0) / 100, c: C.identical }, { v: (pls.minor_changes || 0) / 100, c: C.minor }, { v: (pls.paraphrased || 0) / 100, c: C.para }] : [], plDone ? `${Math.round(simTotal)}%` : pl?.mode === "sample" ? "Sample" : "n/a", "match")}
      <div><div class="k">Similarity</div><div class="s">${scanState(pl)}</div>
      ${plDone ? `<div class="legend"><span><i style="background:${C.identical}"></i>Identical ${pls.identical || 0}%</span><span><i style="background:${C.minor}"></i>Minor changes ${pls.minor_changes || 0}%</span>${pls.paraphrased ? `<span><i style="background:${C.para}"></i>Paraphrased ${pls.paraphrased}%</span>` : ""}</div>` : ""}</div></div>
    <div class="sc statgrid">
      <div><div class="k">Flagged</div><div class="v">${open.length}</div><div class="s">${aiOpen.length} AI · ${plOpen.length} similarity</div></div>
      <div><div class="k">Sources</div><div class="v">${r.sources.length}</div><div class="s">${r.sources[0] ? esc(r.sources[0].title).slice(0, 28) : "none"}</div></div>
      <div><div class="k">Need citation</div><div class="v">${open.filter(needsCitation).length}</div><div class="s">${F().filter((f) => ["fixed", "fixed_pending"].includes(f.state)).length} fixed · ${F().filter((f) => f.state === "reviewed").length} reviewed</div></div>
      <div><div class="k">Coverage</div><div class="v">${cov === null ? "n/a" : cov + "%"}</div><div class="s">${scanned ? scanned.toLocaleString() + " words" : "references excluded"}</div></div>
    </div>
    <div class="sc keypoints"><div class="k">Key points</div>
      ${key.length ? key.map((f) => `<button class="kp" data-hl="${f.id}"><span class="dotc" style="background:${f.type === "ai" ? C.ai : C.identical}"></span><span><b>${lab} ${f.location} · ${f.type === "ai" ? (f.score != null ? Math.round(f.score * 100) + "% AI" : "AI") : TYPE_LABEL[f.match_type] || "Match"}${needsCitation(f) ? " · no citation" : ""}</b><br>${esc(f.text.slice(0, 90))}${f.text.length > 90 ? "..." : ""}</span></button>`).join("")
        : `<p class="note">${ai || pl ? "Nothing flagged in the latest scan." : "Run a scan to see the passages that need attention."}</p>`}
    </div>
  </div>
  <details class="warnline"><summary><strong>Read results with care:</strong> AI detection is a signal, not proof.</summary>Formal, technical, non-native and highly standardised academic writing can be flagged wrongly. Similarity is not plagiarism: quoted and cited material and common phrases also match.${S.status.copyleaks === "sample" ? " <strong>Sample mode:</strong> no detector key is set, so findings are placeholders." : ""}</details>`;
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
  $("#back").onclick = () => go("/scans");
  app.querySelectorAll("[data-hl]").forEach((b) => (b.onclick = () => select(b.dataset.hl, true)));
  $("#copyText").onclick = async () => {
    const txt = S.report.elements.filter((e) => e.text.trim()).map((e) => e.text).join("\n\n");
    try { await navigator.clipboard.writeText(txt); toast("Text copied to the clipboard."); } catch { toast("Copy failed. Download the file instead.", true); }
  };
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
  if (res) { const err = res.find((x) => x.status === "error"); if (err) toast(`${err.kind} scan: ${err.message}`, true); S.me = await D.me(); refreshSide(); }
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
