// Winston AI provider (https://docs.gowinston.ai). AI detection and plagiarism are both synchronous.
import { findText } from "./shared.ts";

const API = "https://api.gowinston.ai/v2";
const key = () => (Deno.env.get("WINSTON_API_KEY") || "").trim();
export const winstonEnabled = () => !!key();
export const WINSTON_AI_MIN = 300, WINSTON_AI_MAX = 140000, WINSTON_PLAG_MAX = 110000;
const AI_THRESHOLD = 50; // Winston sentence score is a HUMAN score 0..100; at or below 50 we flag it as likely AI

async function call(path: string, body: unknown) {
  const r = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) {
    const msg = data?.description || data?.error || text.slice(0, 300);
    if (r.status === 402 || text.includes("INSUFFICIENT_CREDIT")) {
      const need = text.match(/cost (\d+) credits/), have = text.match(/have (\d+) credits/);
      throw new Error(`Not enough Winston AI credits for this check${need ? ` (needs ${need[1]}, ${have ? have[1] : "fewer"} left)` : ""}. Top up at dev.gowinston.ai/billing, or scan a shorter document.`);
    }
    throw new Error(`Winston AI ${path} failed (${r.status}): ${msg}`);
  }
  return data;
}

/** Split scan text into request-size pieces at paragraph boundaries: [global offset, text]. */
function pieces(text: string, max: number): [number, string][] {
  const out: [number, string][] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n\n", end);
      if (cut > start + max * 0.5) end = cut;
    }
    out.push([start, text.slice(start, end)]);
    start = end;
  }
  // merge a too-short last piece into the previous one when possible
  if (out.length > 1 && out[out.length - 1][1].trim().length < WINSTON_AI_MIN) {
    const [o] = out[out.length - 2];
    out.splice(out.length - 2, 2, [o, text.slice(o)]);
  }
  return out;
}

export type WSection = { start: number; length: number; probability: number; phrases: [number, number][] };

export async function winstonAI(text: string) {
  if (text.trim().length < WINSTON_AI_MIN) throw new Error(`Winston AI needs at least ${WINSTON_AI_MIN} characters of text for AI detection.`);
  const sections: WSection[] = [];
  let humanWeighted = 0, chars = 0, version = "", credits = 0;
  const raw: unknown[] = [];
  for (const [offset, piece] of pieces(text, WINSTON_AI_MAX)) {
    if (piece.trim().length < WINSTON_AI_MIN) continue;
    const d = await call("ai-content-detection", { text: piece, sentences: true, language: "auto" });
    if (raw.length < 3) raw.push({ ...d, sentences: (d.sentences || []).slice(0, 50) });
    version = d.version || version;
    credits += d.credits_used || 0;
    humanWeighted += (d.score ?? 0) * piece.length;
    chars += piece.length;
    // Winston returns sentence text without offsets: find each one in order
    let cursor = 0;
    for (const s of d.sentences || []) {
      const st = String(s.text || "").trim();
      if (!st) continue;
      const at = piece.indexOf(st, cursor);
      let hit: [number, number] | null = at >= 0 ? [at, at + st.length] : null;
      if (!hit) { const f = findText(piece.slice(cursor), st); hit = f ? [cursor + f[0], cursor + f[1]] : findText(piece, st, cursor); }
      if (!hit) continue;
      cursor = hit[1];
      if (typeof s.score === "number" && s.score <= AI_THRESHOLD) {
        sections.push({ start: offset + hit[0], length: hit[1] - hit[0], probability: Math.round((100 - s.score)) / 100, phrases: [] });
      }
    }
  }
  return { provider: "Winston AI", mode: "live", docAI: chars ? 1 - humanWeighted / chars / 100 : null, sections, model: version, raw, credits };
}

export type WMatch = { result_id: string; type: string; start: number; end: number; excerpt: string };
export async function winstonPlagiarism(text: string) {
  const sources: any[] = [];
  const matches: WMatch[] = [];
  let words = 0, plagWords = 0, identical = 0, similar = 0, credits = 0, scoreW = 0;
  const raw: unknown[] = [];
  for (const [offset, piece] of pieces(text, WINSTON_PLAG_MAX)) {
    if (piece.trim().length < 100) continue;
    const d = await call("plagiarism", { text: piece, language: "auto" });
    if (raw.length < 3) raw.push({ result: d.result, sources: (d.sources || []).slice(0, 20).map((s: any) => ({ ...s, plagiarismFound: (s.plagiarismFound || []).slice(0, 20) })) });
    credits += d.credits_used || 0;
    words += d.result?.textWordCounts || 0;
    scoreW += (d.result?.score || 0) * (d.result?.textWordCounts || 0);
    plagWords += d.result?.totalPlagiarismWords || 0;
    identical += d.result?.identicalWordCounts || 0;
    similar += d.result?.similarWordCounts || 0;
    for (const s of d.sources || []) {
      if (s.is_excluded) continue;
      const rid = `w${sources.length + 1}`;
      sources.push({ id: rid, title: s.title || s.url || "Untitled source", url: s.url || null, introduction: s.description || "",
        matchedWords: s.plagiarismWords || 0, author: s.author || "", date: s.publishedDate || "", citation: !!s.citation });
      const type = (s.identicalWordCounts || 0) >= (s.similarWordCounts || 0) ? "identical" : "minor_changes";
      for (const m of s.plagiarismFound || []) {
        let g: [number, number] | null = null;
        if (m.sequence) g = findText(piece, String(m.sequence), m.startIndex ?? 0);
        if (!g && Number.isInteger(m.startIndex) && Number.isInteger(m.endIndex) && m.endIndex > m.startIndex && m.endIndex <= piece.length) g = [m.startIndex, m.endIndex];
        if (!g) continue;
        matches.push({ result_id: rid, type, start: offset + g[0], end: offset + g[1], excerpt: "" });
      }
    }
  }
  const pct = (n: number) => (words ? Math.round((1000 * n) / words) / 10 : 0);
  return {
    sources, matches, credits, raw,
    summary: { identical: pct(identical), minor_changes: pct(similar), paraphrased: 0, aggregated: words ? Math.round((10 * scoreW) / words) / 10 : pct(plagWords), total_words: words, provider_note: "Winston AI reports identical and similar words; similar is shown as minor changes." },
  };
}
