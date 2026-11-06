// Shared server code for Verity edge functions: auth, Copyleaks, text mapping, sample mode.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}
export async function userFrom(req: Request, db: SupabaseClient) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data.user ?? null;
}

// ---------------- configuration ----------------
const env = (k: string) => (Deno.env.get(k) || "").trim();
export const cfg = {
  clEmail: env("COPYLEAKS_EMAIL"),
  clKey: env("COPYLEAKS_API_KEY"),
  clSandbox: !["false", "0", "no", "off"].includes(env("COPYLEAKS_SANDBOX").toLowerCase()),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
  functionsBase: `${Deno.env.get("SUPABASE_URL")}/functions/v1`,
};
export const copyleaksMode = () => (cfg.clEmail && cfg.clKey ? (cfg.clSandbox ? "sandbox" : "live") : "sample");
export const claudeMode = () => (cfg.anthropicKey ? "live" : "sample");

// ---------------- scan text and mapping ----------------
export type El = { id: string; text: string; location: number; heading?: boolean };
export type Span = [string, number, number];
const SEP = "\n\n";
const REF_HEAD = /^\s*(references|bibliography|works cited|literaturverzeichnis|quellen)\s*$/i;

export function buildScanText(elements: El[]) {
  let text = "";
  const spans: Span[] = [];
  let inRefs = false;
  for (const el of elements) {
    if (!el.text.trim()) continue;
    if (el.heading && REF_HEAD.test(el.text)) { inRefs = true; continue; }
    if (inRefs) { if (el.heading) inRefs = false; else continue; }
    if (text) text += SEP;
    spans.push([el.id, text.length, text.length + el.text.length]);
    text += el.text;
  }
  return { text, spans };
}
export function locate(spans: Span[], start: number, length: number) {
  const end = start + length;
  const out: [string, number, number][] = [];
  for (const [id, s, e] of spans) {
    if (s < end && e > start) {
      const a = Math.max(start, s), b = Math.min(end, e);
      if (b > a) out.push([id, a - s, b - s]);
    }
  }
  return out;
}
export function chunks(text: string, spans: Span[], max: number) {
  const out: [number, string][] = [];
  let cs: number | null = null, ce = 0;
  for (const [, s, e] of spans) {
    if (cs === null) { cs = s; ce = e; }
    else if (e - cs > max) { out.push([cs, text.slice(cs, ce)]); cs = s; ce = e; }
    else ce = e;
  }
  if (cs !== null) out.push([cs, text.slice(cs, ce)]);
  const final: [number, string][] = [];
  for (let [off, t] of out) {
    while (t.length > max) { final.push([off, t.slice(0, max)]); off += max; t = t.slice(max); }
    final.push([off, t]);
  }
  return final;
}
// normalised search: provider text may differ in quotes, dashes and whitespace
function normWithMap(s: string) {
  let out = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if ("‘’".includes(c)) c = "'";
    else if ("“”".includes(c)) c = '"';
    else if ("–—".includes(c)) c = "-";
    if (/\s/.test(c)) { if (lastSpace) continue; c = " "; lastSpace = true; } else lastSpace = false;
    out += c.toLowerCase();
    map.push(i);
  }
  return { out, map };
}
export function findText(text: string, snippet: string, hint?: number): [number, number] | null {
  if (!snippet.trim()) return null;
  let idx = text.indexOf(snippet);
  if (idx >= 0) {
    if (hint !== undefined) {
      let best = idx, i = idx;
      while (i >= 0) { if (Math.abs(i - hint) < Math.abs(best - hint)) best = i; i = text.indexOf(snippet, i + 1); }
      idx = best;
    }
    return [idx, idx + snippet.length];
  }
  const T = normWithMap(text), S = normWithMap(snippet.trim());
  const j = T.out.indexOf(S.out);
  if (j < 0) return null;
  return [T.map[j], T.map[j + S.out.length - 1] + 1];
}

const CITE_NEAR = /\((?:[^()]{0,160}?\b(?:1[6-9]|20)\d{2}[a-z]?[^()]*)\)|\[\d+(?:\s*[,\-–]\s*\d+)*\]/;
export function citationStatus(elText: string, a: number, b: number) {
  const before = elText.slice(Math.max(0, a - 3), a), after = elText.slice(b, b + 3);
  const quoted = /["“]/.test(before) && /["”]/.test(after);
  const cited = CITE_NEAR.test(elText.slice(a, Math.min(elText.length, b + 160)));
  return { quoted, cited };
}

// ---------------- Copyleaks ----------------
const ID_URL = "https://id.copyleaks.com/v3/account/login/api";
const API = "https://api.copyleaks.com";
export const AI_CHUNK = 20000, AI_MIN = 255;
let token: { value: string; at: number } | null = null;

async function clToken() {
  if (token && Date.now() - token.at < 47 * 3600 * 1000) return token.value;
  const r = await fetch(ID_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: cfg.clEmail, key: cfg.clKey }) });
  if (!r.ok) throw new Error(`Copyleaks login failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  token = { value: (await r.json()).access_token, at: Date.now() };
  return token.value;
}
const clHeaders = async () => ({ Authorization: `Bearer ${await clToken()}`, "Content-Type": "application/json" });

export type AISection = { start: number; length: number; probability: number | null; phrases: [number, number][] };
export async function detectAI(text: string, parts: [number, string][], scanKey: string) {
  if (copyleaksMode() === "sample") return sampleAI(text);
  if (text.trim().length < AI_MIN) throw new Error(`Copyleaks needs at least ${AI_MIN} characters of text for AI detection.`);
  const merged: [number, string][] = [];
  for (const [off, c] of parts) {
    if (merged.length && c.length < AI_MIN) { const [po] = merged[merged.length - 1]; merged[merged.length - 1] = [po, text.slice(po, off + c.length)]; }
    else merged.push([off, c]);
  }
  const sections: AISection[] = [];
  let aiWords = 0, total = 0, model = "";
  const raw: unknown[] = [];
  for (const [n, [offset, chunk]] of merged.entries()) {
    const sid = `${scanKey.slice(0, 28)}-ai${n}`;
    const body: Record<string, unknown> = { text: chunk, sandbox: cfg.clSandbox, explain: true };
    let r = await fetch(`${API}/v2/writer-detector/${sid}/check`, { method: "POST", headers: await clHeaders(), body: JSON.stringify(body) });
    if (r.status === 400) {
      const t = await r.text();
      if (t.includes("explain")) { delete body.explain; r = await fetch(`${API}/v2/writer-detector/${sid}/check`, { method: "POST", headers: await clHeaders(), body: JSON.stringify(body) }); }
      else throw new Error(`Copyleaks AI detection failed (400): ${t.slice(0, 300)}`);
    }
    if (!r.ok) throw new Error(`Copyleaks AI detection failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    if (raw.length < 5) raw.push(d);
    model = d.modelVersion || model;
    const words = chunk.split(/\s+/).filter(Boolean).length;
    total += words;
    if (d.summary?.ai != null) aiWords += Number(d.summary.ai) * words;
    const lc = d.explain?.patterns?.text?.chars || {};
    const phrases: [number, number][] = (lc.starts || []).map((s: number, i: number) => [s, lc.lengths[i]]);
    for (const res of d.results || []) {
      if (res.classification !== 2) continue;
      for (const m of res.matches || []) {
        const ch = m.text?.chars || {};
        (ch.starts || []).forEach((s: number, i: number) => {
          const ln = ch.lengths[i];
          sections.push({ start: offset + s, length: ln, probability: res.probability ?? null,
            phrases: phrases.filter(([ps, pl]) => ps >= s && ps + pl <= s + ln).map(([ps, pl]) => [offset + ps, pl]) });
        });
      }
    }
  }
  return { provider: "Copyleaks", mode: copyleaksMode(), docAI: total ? aiWords / total : null, sections, model, raw };
}
function sampleAI(text: string) {
  const sections: AISection[] = [];
  for (const m of text.matchAll(/[^.!?\n]{140,}[.!?]/g)) {
    if (sections.length >= 4) break;
    const lead = m[0].length - m[0].trimStart().length;
    sections.push({ start: m.index! + lead, length: m[0].trim().length, probability: null, phrases: [] });
  }
  return { provider: "Sample data (no Copyleaks key)", mode: "sample", docAI: null, sections, model: "sample", raw: [] };
}
export async function submitPlagiarism(text: string, providerScanId: string, statusHook: string, payload: string) {
  const body = { base64: encodeBase64(new TextEncoder().encode(text)), filename: "document.txt",
    properties: { sandbox: cfg.clSandbox, webhooks: { status: statusHook }, developerPayload: payload } };
  const r = await fetch(`${API}/v3/scans/submit/file/${providerScanId}`, { method: "PUT", headers: await clHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Copyleaks plagiarism submit failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
}
export async function exportResults(providerScanId: string, exportId: string, ids: string[], base: string) {
  const body = {
    results: ids.slice(0, 1000).map((id) => ({ id, verb: "POST", endpoint: `${base}/result/${encodeURIComponent(id)}` })),
    crawledVersion: { verb: "POST", endpoint: `${base}/crawled` },
    completionWebhook: `${base}/export-completed`, maxRetries: 3,
  };
  const r = await fetch(`${API}/v3/downloads/${providerScanId}/export/${exportId}`, { method: "POST", headers: await clHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Copyleaks export failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
}

// ---------------- plagiarism findings ----------------
export type Match = { result_id: string; type: string; start: number; end: number; excerpt: string };
export async function storePlagFindings(db: SupabaseClient, scan: any, matches: Match[], srcIds: Record<string, string>) {
  const { data: version } = await db.from("versions").select("id, elements").eq("id", scan.version_id).single();
  const els: Record<string, El> = Object.fromEntries((version!.elements as El[]).map((e) => [e.id, e]));
  const per: Record<string, [number, number, string][]> = {};
  for (const m of matches) {
    for (const [id, a, b] of locate(scan.spans, m.start, m.end - m.start)) {
      const k = `${id}\u0001${m.result_id}\u0001${m.type}`;
      (per[k] = per[k] || []).push([a, b, m.excerpt]);
    }
  }
  const rows: any[] = [];
  for (const [k, spans] of Object.entries(per)) {
    const [elId, rid, mtype] = k.split("\u0001");
    spans.sort((x, y) => x[0] - y[0]);
    const merged: [number, number, string][] = [];
    for (const [a, b, ex] of spans) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 2) { last[1] = Math.max(last[1], b); last[2] = (last[2] + " " + ex).trim(); }
      else merged.push([a, b, ex]);
    }
    const el = els[elId];
    for (const [a, b, ex] of merged) {
      const text = el.text.slice(a, b);
      if (text.split(/\s+/).filter(Boolean).length < 4) continue;
      rows.push({ document_id: scan.document_id, version_id: scan.version_id, scan_id: scan.id, user_id: scan.user_id, type: "plagiarism",
        element_id: elId, location: el.location, start_pos: a, end_pos: b, text, match_type: mtype, source_id: srcIds[rid] || null,
        source_excerpt: ex.slice(0, 4000), citation_status: citationStatus(el.text, a, b), evidence: { provider: scan.provider, mode: scan.mode } });
    }
  }
  if (rows.length) await db.from("findings").insert(rows);
  return rows.length;
}
export function samplePlagiarism(text: string) {
  const m = text.match(/[^.!?\n]{60,}[.!?]/);
  if (!m) return { sources: [], matches: [] as Match[] };
  return {
    sources: [{ id: "sample-1", title: "Sample source (not a real match)", url: null, introduction: "Sample mode: add Copyleaks keys for real sources.", matchedWords: m[0].split(/\s+/).length }],
    matches: [{ result_id: "sample-1", type: "identical", start: m.index!, end: m.index! + m[0].length, excerpt: "" }],
  };
}
