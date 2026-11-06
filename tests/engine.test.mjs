// Node tests for js/engine.js. Run: node tests/engine.test.mjs <fixtures dir>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(process.env.NODE_MODULES_HINT || import.meta.url);
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
import * as E from "../js/engine.js";

E.setEnv({ JSZip, DOMParser, XMLSerializer, subtle: globalThis.crypto.subtle });
const dir = process.argv[2];
const read = (n) => new Uint8Array(fs.readFileSync(path.join(dir, n)));
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok  ", name); }
  catch (e) { fail++; console.log("FAIL", name, "\n     ", e.stack.split("\n").slice(0, 3).join("\n      ")); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const els = async (d) => E.extract(await E.openPackage(d));
const keep = (tpl, words) => (words + " " + [...tpl.template.matchAll(E.TOKEN_RE)].map((m) => m[0]).join(" ")).trim() + ".";
const outDir = path.join(dir, "js_out");
fs.mkdirSync(outDir, { recursive: true });

const docx = read("thesis.docx"), pptx = read("deck.pptx");

await t("1 docx: replace one paragraph, rest identical", async () => {
  const p8 = (await els(docx)).find((e) => e.text.includes("Digital technology has"));
  const tpl = await E.prepare(docx, p8.id);
  const { data, report } = await E.apply(docx, p8.id, tpl.start, tpl.end, keep(tpl, "Rewritten text"), tpl.element_hash);
  const a = await els(docx), b = await els(data);
  a.forEach((x, i) => { if (x.id !== p8.id) assert(x.hash === b[i].hash, x.id); });
  assert(report.paragraphs_verified_unchanged === a.length - 1);
  fs.writeFileSync(path.join(outDir, "t1.docx"), data);
});
await t("2 pptx: replace a sentence on slide 5", async () => {
  const target = (await els(pptx)).find((e) => e.location === 5 && e.text.includes("Online learning"));
  const s = target.text.indexOf(" Online learning");
  const tpl = await E.prepare(pptx, target.id, s, target.text.length);
  const { data, report } = await E.apply(pptx, target.id, tpl.start, tpl.end, " Digital platforms changed how universities teach.", tpl.element_hash);
  const after = (await els(data)).find((e) => e.id === target.id);
  assert(after.text === "Body text on slide 5. This bold phrase matters. Digital platforms changed how universities teach.", after.text);
  assert(report.edited_part.startsWith("ppt/slides/slide"));
  fs.writeFileSync(path.join(outDir, "t2.pptx"), data);
});
await t("3 citation field, citation and bold term kept", async () => {
  const p8 = (await els(docx)).find((e) => e.text.includes("Digital technology has"));
  const tpl = await E.prepare(docx, p8.id);
  const kinds = new Set(tpl.tokens.map((x) => x.kind));
  assert(kinds.has("field") && kinds.has("citation") && kinds.has("format"), [...kinds].join());
  const { data } = await E.apply(docx, p8.id, tpl.start, tpl.end, keep(tpl, "New wording"), tpl.element_hash);
  const after = (await els(data)).find((e) => e.id === p8.id);
  assert(after.text.includes("(Castells, 2010)") && after.text.includes("(Norris, 2001, p. 12)"));
  const bold = after.segments.find((s) => s.text === "significantly");
  assert(bold && bold.fmt.includes("b"), "bold kept");
  fs.writeFileSync(path.join(outDir, "t3.docx"), data);
});
await t("4 multi-run range only", async () => {
  const p8 = (await els(docx)).find((e) => e.text.includes("Digital technology has"));
  const s = p8.text.indexOf("Scholars"), e = p8.text.indexOf(" across");
  const tpl = await E.prepare(docx, p8.id, s, e);
  const nt = tpl.template.replace("Scholars note this shift is", "Researchers find the change");
  const { data } = await E.apply(docx, p8.id, tpl.start, tpl.end, nt, tpl.element_hash);
  const after = (await els(data)).find((x) => x.id === p8.id);
  assert(after.text === p8.text.slice(0, s) + "Researchers find the change uneven" + p8.text.slice(e), after.text);
});
await t("5 dropped token refused", async () => {
  const p8 = (await els(docx)).find((e) => e.text.includes("Digital technology has"));
  const tpl = await E.prepare(docx, p8.id);
  let threw = false;
  try { await E.apply(docx, p8.id, tpl.start, tpl.end, "All citations removed.", tpl.element_hash); } catch (e) { threw = e instanceof E.EditError; }
  assert(threw);
});
await t("stale hash refused", async () => {
  const p8 = (await els(docx)).find((e) => e.text.includes("Digital technology has"));
  const tpl = await E.prepare(docx, p8.id);
  let threw = false;
  try { await E.apply(docx, p8.id, tpl.start, tpl.end, tpl.template, "0".repeat(64)); } catch (e) { threw = true; }
  assert(threw);
});
await t("hyperlink protected", async () => {
  const p = (await els(docx)).find((e) => e.text.includes("See the dataset"));
  const tpl = await E.prepare(docx, p.id);
  assert(tpl.tokens.some((x) => x.kind === "link" && x.text === "the project archive"));
});
await t("8 ten edits in a row keep other parts", async () => {
  let cur = docx;
  const ids = (await els(docx)).filter((e) => e.text.startsWith("This is paragraph")).slice(0, 10).map((e) => e.id);
  for (const [i, id] of ids.entries()) {
    const tpl = await E.prepare(cur, id);
    cur = (await E.apply(cur, id, tpl.start, tpl.end, keep(tpl, `Edit number ${i}`), tpl.element_hash)).data;
  }
  fs.writeFileSync(path.join(outDir, "t8.docx"), cur);
});
for (const f of ["lo_thesis.docx", "lo_deck.pptx"]) {
  await t(`edit every paragraph of LibreOffice file ${f}`, async () => {
    let cur = read(f);
    const list = (await els(cur)).filter((e) => e.text.trim());
    for (const e of list) {
      const tpl = await E.prepare(cur, e.id);
      cur = (await E.apply(cur, e.id, tpl.start, tpl.end, keep(tpl, "Edited text"), tpl.element_hash)).data;
    }
    fs.writeFileSync(path.join(outDir, "all_" + f), cur);
  });
}
await t("analyse stats", async () => {
  const a = await E.analyse(pptx);
  assert(a.fmt === "pptx" && a.stats.locations === 10 && a.stats.language === "en", JSON.stringify(a.stats));
  assert(a.elements.some((e) => e.heading));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
