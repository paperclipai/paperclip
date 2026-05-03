# Translation Plan — paperclip-ko

This document defines the ongoing strategy for keeping `yong076/paperclip-ko` in lockstep with upstream `paperclipai/paperclip` while maintaining a complete Korean localization.

> **Status**: Phase 0 (foundations) — README + Attribution + this plan are in place. Phase 1+ (i18n infrastructure, automation, bulk translation) is queued.

---

## Goals

1. **Korean parity** — UI, CLI, docs, errors, and supporting materials should all read naturally in Korean.
2. **Upstream-friendly** — The translation should not diverge functionally. We track upstream weekly.
3. **Sustainable** — One person cannot manually translate every upstream change. Automation is mandatory.
4. **Eventually upstream-ed** — The i18n infrastructure (not the Korean strings) should be proposed as an upstream PR. Korean would then live as one of many locales in upstream.

## Non-Goals

- Forking the product direction.
- Diverging from upstream's data model, schemas, or API surface.
- Creating a "Korean-only" feature.

---

## Phases

### Phase 0 — Foundations  ✅
- Fork to `yong076/paperclip-ko`
- Korean README skeleton (`README.ko.md`)
- Attribution + license preservation (`ATTRIBUTION.md`)
- This plan

### Phase 1 — i18n Infrastructure (the load-bearing work)
This is the most consequential phase. The choices here decide whether the translation is sustainable.

**Recommended stack**:
- **`i18next` + `react-i18next`** for the React UI (de facto standard, supports lazy loading, namespacing, ICU plurals)
- **`i18next` (server-side)** for the Node API server's user-facing strings (CLI prompts, error messages exposed to users)
- **JSON locale files** under `i18n/{en,ko}/*.json`, namespaced by feature area (`i18n/{lng}/onboard.json`, `.../org-chart.json`, ...)
- Source language: **English** (`en`). All keys derive from English source. Korean is a translation target.

**Steps**:
1. Add `i18next` + `react-i18next` to UI workspace (`packages/ui` or wherever React lives)
2. Initialize `i18n.ts` with English as fallback, Korean as primary for `ko-*` locales
3. Refactor 1–2 high-visibility components (e.g. onboarding wizard, top nav) to use `t('key')`
4. Create `i18n/en/<namespace>.json` and `i18n/ko/<namespace>.json` for those components
5. Add a CI lint that fails if a new English string is added without a key in `i18n/en/`
6. Document the pattern in `CONTRIBUTING.md` so upstream can adopt it

**Server-side**:
- Keep simple — just a `t(key, lng)` helper that loads from `i18n/{lng}/server-*.json`
- Default `lng` from `Accept-Language` header (board user) or company setting

### Phase 2 — Bulk String Extraction
Once Phase 1 patterns are in place, extract all hardcoded strings from:
- All `*.tsx` UI components
- CLI prompts (`cli/`)
- User-facing error messages (`server/**/errors.ts`)
- Email templates (if any)

**Tooling**:
- A custom AST walker (`scripts/extract-strings.ts`) using `@babel/parser` to find:
  - JSX text nodes
  - String literals passed to specific functions (e.g. `toast(...)`, `notify(...)`)
  - String props on heading/label/button components
- Output: per-file diff report + auto-generated `i18n/en/*.json` keys with stable hash-based names
- Apply diffs in batches (~10–20 components per PR)

### Phase 3 — Documentation Translation
- `README.ko.md` ✅ (Phase 0)
- `doc/DEVELOPING.md` → `doc/DEVELOPING.ko.md`
- `docs/**/*.md` → `docs/**/*.ko.md`
- `ROADMAP.md`, `CONTRIBUTING.md`, `SECURITY.md` → `.ko.md` siblings

**Convention**: keep English files unchanged, add `.ko.md` siblings. Cross-link top-of-file.

### Phase 4 — Automation
The point where this becomes sustainable.

**GitHub Action — weekly upstream sync** (`.github/workflows/upstream-sync.yml`):
1. Runs every Monday 09:00 KST
2. `git fetch upstream master`
3. Open PR `chore: sync upstream <commit-sha>` (do not auto-merge)
4. CI compares `i18n/en/**` between `main` and the upstream-synced branch:
   - New keys → call Claude API (or Codex) to translate to Korean
   - Removed keys → delete from `i18n/ko/**`
   - Modified English → flag for human review (don't silently re-translate)
5. Push translation patches to the same PR
6. Maintainer reviews, merges

**Paperclip routine — recursive dogfooding**:
- Inside the running Paperclip instance, create company `Paperclip-KO`
- Hire an agent: `Translator-Bot` (Claude Sonnet)
- Routine: cron `0 9 * * 1` (Mondays 09:00 KST)
- Routine task:
  - Pull `yong076/paperclip-ko` upstream-sync branch
  - Run extraction → translation → PR comment with diff
- This way Paperclip itself becomes the proof of its own usefulness

### Phase 5 — Upstream PR
Once Phase 1 i18n infrastructure is solid and battle-tested in this fork:

1. Open issue at `paperclipai/paperclip` proposing i18n adoption
2. PR adds `i18next`, English locale extraction, no Korean files
3. After merge, second PR adds Korean as the first non-English locale
4. Going forward, Korean translation lives in upstream; this fork narrows to "stuff upstream doesn't accept" or potentially gets archived

---

## Translation Style Guide

### Tone
- **Marketing copy** (README, landing pages): direct, slightly punchy, 합니다체 by default. Mirror Panic Inc / Linear voice — short, specific, no fluff.
- **UI labels**: 단정형. 짧게. Avoid 안내문 톤 ("~해 주시기 바랍니다").
- **Error messages**: clear cause + next action. 해요체 OK for less alarming errors, 합니다체 for system-level.
- **CLI**: 합니다체. Match the original's brevity.

### Terminology Decisions

| English             | Korean (preferred)               | Notes                                                   |
| ------------------- | -------------------------------- | ------------------------------------------------------- |
| Agent               | 에이전트                         | Don't translate — established term                      |
| Heartbeat           | 하트비트                         | Keep as loanword                                        |
| Org chart           | 조직도                           |                                                         |
| Budget              | 예산                             |                                                         |
| Governance          | 거버넌스                         | Don't translate — used as-is in Korean tech writing     |
| Routine             | 루틴                             |                                                         |
| Workspace           | 워크스페이스                     |                                                         |
| Issue / Ticket      | 이슈 / 티켓                      |                                                         |
| Bring your own X    | 직접 가져온 X                    | Or "BYOX" in headers                                    |
| Pull request        | PR                               | Acronym preferred                                       |
| Onboard             | 온보딩 / 셋업                    | Context-dependent                                       |
| Self-hosted         | 셀프 호스팅                      |                                                         |
| Multi-company       | 멀티 컴퍼니                      |                                                         |
| Commit              | 커밋                             |                                                         |
| Hire (an agent)     | 채용                             | Keep the metaphor                                       |
| Fire / Terminate    | 종료                             | Avoid "해고" — too human                                |

### When in doubt
1. Check existing translations in `i18n/ko/` for consistency.
2. Pick the term that a Korean developer reading on a phone would understand fastest.
3. Don't translate proper nouns (Claude, Codex, Cursor, OpenClaw, Paperclip, etc.).
4. Don't translate code blocks or shell commands.

---

## Maintenance Cadence

| Cadence    | Action                                                                  |
| ---------- | ----------------------------------------------------------------------- |
| Weekly     | Auto-sync from upstream (Action) → review translation PR                |
| Monthly    | Review translation drift, fix awkward phrasings discovered in usage     |
| Quarterly  | Audit terminology table — consolidate inconsistent translations         |
| On request | Hot-fix obviously broken translations from issues                       |

---

## Open Questions

- Do we want a Korean-language Discord channel or stay on upstream Discord?
- Should `paperclipai configure` have a language toggle or auto-detect from `LANG`?
- For LLM-based translations: do we use Claude API directly, or route through Paperclip's hired Translator-Bot? (Latter is more dogfood-y but adds a step.)

These get decided as Phase 1+ proceeds.
