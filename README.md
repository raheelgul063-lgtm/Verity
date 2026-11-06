# Verity AI

Check Word and PowerPoint files for AI writing and plagiarism, then fix only the flagged passages. Every other paragraph, slide, image, table, header, footer and style stays as it was, and this is verified before each new version is saved.

Live: https://raheelgul063-lgtm.github.io/verity/

## How it is built

* **Website**: plain HTML/JS on GitHub Pages (`index.html`, `js/`, `css/`).
* **Editing engine**: `js/engine.js` runs in the browser. It opens the DOCX/PPTX with JSZip, changes text inside the runs of one paragraph, copies every other file part unchanged, and refuses the edit if anything else changed.
* **Supabase** (project `btyeujbewductabgbqhb`): login, database with row-level security (each user sees only their own rows), private storage bucket for document versions.
* **Edge functions** (`supabase/functions/`):
  * `scan`: AI detection and plagiarism (Winston AI, synchronous; Copyleaks as fallback); also the AI re-check after a fix and the provider status.
  * `copyleaks-webhook`: receives Copyleaks plagiarism results, exports matched passages, maps them to paragraphs.
  * `rewrite`: Claude rewrites with protected citations, links, quotes and formatted terms.

API keys live only in Supabase secrets, never in this repo or the browser.

## Keys (Supabase dashboard > Edge Functions > Secrets)

| Secret | Value |
| --- | --- |
| `WINSTON_API_KEY` | Winston AI API key (dev.gowinston.ai). When set, Winston is used for AI and plagiarism |
| `COPYLEAKS_EMAIL` | optional fallback provider: Copyleaks account email |
| `COPYLEAKS_API_KEY` | Copyleaks API key |
| `COPYLEAKS_SANDBOX` | `true` for free mock results, `false` for real scans |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_MODEL` | optional, default `claude-sonnet-5-5` |

Without keys the app runs in sample mode and labels every result as sample data.

## Tests

```bash
npm i jszip@3.10.1 @xmldom/xmldom@0.9.5
node tests/engine.test.mjs <folder with thesis.docx, deck.pptx, lo_thesis.docx, lo_deck.pptx>
```

## Known limits

* DOCX: body text, tables and text boxes are scanned and editable; headers, footers, footnotes and comments are kept but not scanned. Page numbers are approximate.
* One edit covers one paragraph. New text takes the formatting of the first run in the selection; bold or italic terms inside it are kept as protected items.
* PDF is not supported yet: save as DOCX first.
