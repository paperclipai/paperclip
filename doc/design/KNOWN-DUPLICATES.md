# Known duplicates & off-limits areas (human-maintained)

Seed list for the audit. Add components you already believe are redundant, and any screens the run must not touch. The auditor treats entries here as leads to verify, not verdicts.

## Suspected duplicates / overlap (leads)

- Chat composers: the shared `ChatComposer` vs `MarkdownEditor`-based task composer — deliberately NOT unified in a prior pass (PAP-101); audit the overlap but flag as "Needs human decision".
- Agent bubble action rows: `AgentBubbleActionRow.tsx` had two parallel implementations created by concurrent work at one point — verify only one remains.
- Status glyphs/chips: `StatusIcon` vs inline-mention chips vs task chips — intentionally separate systems per prior work; document, don't merge.

## Off-limits in this run

- `ui/src/components/theme-editor/` and anything under experimental theme/playground paths, if present on this branch.
- Server code, adapters, CLI — everything outside `ui/`.
