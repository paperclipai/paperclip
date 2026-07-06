# Raw Sources — Manifest

These are the **immutable ground-truth sources** the wiki compiles from. They are *not* copied here
(they already live in the repo and are git-versioned); the LLM reads them in place and never edits them
from within the wiki.

## Primary idea corpus
- `../../0*.md` — the 66 numbered idea files (`001`–`066`) + `../../README.md` index.
  Each is structured as Suggestion / How it could be achieved / Perceived complexity (+ Sources on newer ones).
- Notable recent additions: `065` (Software-Building & Self-Hosting), `066` (Chat Channel — Telegram/WhatsApp).

## Synthesis corpus (combinations)
- `../../combinations/combo-01..13-*.md` — 13 thematic combinations (group ideas by mechanism).
- `../../combinations/README.md` — combination index + source-idea→combo map + build order.
- `../../combinations/cross-cutting/xcombo-01..11-*.md` + `xcombo-code-knowledge-flywheel.md` —
  12 cross-cutting combinations (group by abstraction/scenario/flywheel).
- `../../combinations/cross-cutting/_log.md` — the cross-cutting loop log (done list + procedure).

## Architecture & integration sources
- `../../_skeleton-reference.md` — Paperclip reverse-engineered to its 5-table skeletal kernel.
- `/home/user/Documents/Aisha/PAPERCLIP_INTEGRATION.md` — how Aisha (voice/RAG multi-agent assistant)
  and Paperclip fit together (Aisha = chief, Paperclip = orchestration substrate).

## External research
- `research-sources.md` — consolidated bibliography of all web + arXiv sources gathered while developing
  the combinations (grouped by topic, with the combos each grounds).
