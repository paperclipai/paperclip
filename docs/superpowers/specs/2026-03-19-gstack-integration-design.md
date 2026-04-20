# gstack Skills Integration Design

**Date:** 2026-03-19
**Status:** Approved
**Author:** Claude (brainstorming session)

## Summary

Integrate Garry Tan's gstack skills (15 specialist skills + 6 power tools) into Paperclip as native skills, available to all Paperclip users by default. Agents will automatically detect when to use these skills based on context. Browser-dependent skills will use Lightpanda (lightweight Chromium alternative).

## Requirements

| Requirement | Decision |
|-------------|----------|
| **Scope** | All 21 gstack skills |
| **Availability** | ALL Paperclip users by default |
| **Invocation** | Automatic skill detection by agents |
| **Browser** | Full browser via Lightpanda |

## Architecture

```
paperclip/
├── skills/
│   ├── paperclip/                    (existing)
│   ├── paperclip-create-agent/       (existing)
│   ├── gstack-office-hours/          ← NEW
│   ├── gstack-plan-ceo-review/       ← NEW
│   ├── gstack-plan-eng-review/       ← NEW
│   ├── gstack-plan-design-review/    ← NEW
│   ├── gstack-design-consultation/   ← NEW
│   ├── gstack-design-review/         ← NEW
│   ├── gstack-review/                ← NEW
│   ├── gstack-investigate/           ← NEW
│   ├── gstack-qa/                    ← NEW
│   ├── gstack-qa-only/               ← NEW
│   ├── gstack-ship/                  ← NEW
│   ├── gstack-browse/                ← NEW
│   ├── gstack-setup-browser-cookies/ ← NEW
│   ├── gstack-document-release/      ← NEW
│   ├── gstack-retro/                 ← NEW
│   ├── gstack-codex/                 ← NEW
│   ├── gstack-careful/               ← NEW
│   ├── gstack-freeze/                ← NEW
│   ├── gstack-guard/                 ← NEW
│   ├── gstack-unfreeze/              ← NEW
│   └── gstack-upgrade/               ← NEW
│
├── packages/browser/                 ← NEW
│   ├── src/
│   │   ├── index.ts
│   │   ├── lightpanda.ts
│   │   ├── commands.ts
│   │   └── snapshots.ts
│   └── package.json
│
└── pnpm-workspace.yaml               (updated)
```

## Skill Format Conversion

gstack skills use a format with `allowed-tools` frontmatter. Paperclip skills use simpler frontmatter. Conversion rules:

1. Prefix skill names with `gstack-` to avoid collisions
2. Remove `allowed-tools` (Paperclip agents have tool access by role)
3. Adapt bash commands for Paperclip's heartbeat context
4. Replace `$B` (gstack browse binary) with Lightpanda browser tool

**Example conversion:**

gstack format:
```markdown
---
name: review
description: Pre-landing PR review...
allowed-tools:
  - Bash
  - Read
  - Edit
---
```

Paperclip format:
```markdown
---
name: gstack-review
description: >
  Pre-landing PR review. Analyzes diff against base branch for SQL safety,
  LLM trust boundary violations, conditional side effects...
---
```

## Skill Mapping

| gstack skill | Paperclip skill | Description |
|--------------|-----------------|-------------|
| office-hours | gstack-office-hours | YC Office Hours - reframe product ideas |
| plan-ceo-review | gstack-plan-ceo-review | CEO review of plans |
| plan-eng-review | gstack-plan-eng-review | Engineering review of plans |
| plan-design-review | gstack-plan-design-review | Design review of plans |
| design-consultation | gstack-design-consultation | Design system consultation |
| design-review | gstack-design-review | Design audit and fixes |
| review | gstack-review | Staff engineer code review |
| investigate | gstack-investigate | Systematic debugging |
| qa | gstack-qa | QA testing with browser |
| qa-only | gstack-qa-only | QA report without fixes |
| ship | gstack-ship | Release engineering |
| browse | gstack-browse | Browser control |
| setup-browser-cookies | gstack-setup-browser-cookies | Cookie import for auth |
| document-release | gstack-document-release | Doc updates post-release |
| retro | gstack-retro | Weekly retrospective |
| codex | gstack-codex | OpenAI second opinion |
| careful | gstack-careful | Safety guardrails |
| freeze | gstack-freeze | Edit lock |
| guard | gstack-guard | Full safety mode |
| unfreeze | gstack-unfreeze | Remove edit lock |
| gstack-upgrade | gstack-upgrade | Self-updater |

## Browser Integration (Lightpanda)

For `/browse` and `/qa` skills, agents need browser capabilities. We'll use Lightpanda from https://github.com/lightpanda-io/browser.

**Browser commands:**
| Command | Description |
|---------|-------------|
| `navigate(url)` | Go to URL |
| `click(selector)` | Click element |
| `fill(selector, text)` | Type into input |
| `screenshot()` | Capture page |
| `snapshot()` | Get page as markdown |

**Integration:**
1. Create `packages/browser/` with Lightpanda launcher
2. Export browser commands as tools for skills
3. `gstack-browse` skill wraps browser tools

## Automatic Skill Detection

Agents automatically detect when to use gstack skills based on context:

| Skill | Trigger conditions |
|-------|-------------------|
| gstack-office-hours | User describes new feature idea, asks "what should we build" |
| gstack-plan-ceo-review | Agent about to implement major feature |
| gstack-review | Code changes exist, agent about to commit/merge |
| gstack-qa | Agent needs to test UI, user mentions "test the app" |
| gstack-ship | Agent ready to push/merge code |
| gstack-investigate | Error occurs, test fails, unexpected behavior |
| gstack-browse | Agent needs to see webpage or test UI |

**Implementation:**
1. Skill descriptions in SKILL.md frontmatter
2. Agent system prompt includes skill descriptions
3. Heartbeat procedure checks for trigger conditions
4. When triggered, agent invokes appropriate skill

## Implementation Phases

### Phase 1: Core Skills (No Browser)
- gstack-office-hours
- gstack-plan-ceo-review
- gstack-plan-eng-review
- gstack-review
- gstack-investigate
- gstack-careful
- gstack-freeze / gstack-unfreeze
- gstack-guard

### Phase 2: Browser Package
- Create packages/browser/ with Lightpanda
- Browser commands: navigate, click, fill, screenshot, snapshot
- Add to workspace

### Phase 3: Browser-Dependent Skills
- gstack-browse
- gstack-qa
- gstack-qa-only
- gstack-setup-browser-cookies

### Phase 4: Remaining Skills
- gstack-design-consultation
- gstack-design-review
- gstack-plan-design-review
- gstack-ship
- gstack-retro
- gstack-codex
- gstack-document-release
- gstack-upgrade

## Files to Create

```
skills/gstack-office-hours/SKILL.md
skills/gstack-plan-ceo-review/SKILL.md
skills/gstack-plan-eng-review/SKILL.md
skills/gstack-plan-design-review/SKILL.md
skills/gstack-design-consultation/SKILL.md
skills/gstack-design-review/SKILL.md
skills/gstack-review/SKILL.md
skills/gstack-investigate/SKILL.md
skills/gstack-qa/SKILL.md
skills/gstack-qa-only/SKILL.md
skills/gstack-ship/SKILL.md
skills/gstack-browse/SKILL.md
skills/gstack-setup-browser-cookies/SKILL.md
skills/gstack-document-release/SKILL.md
skills/gstack-retro/SKILL.md
skills/gstack-codex/SKILL.md
skills/gstack-careful/SKILL.md
skills/gstack-freeze/SKILL.md
skills/gstack-guard/SKILL.md
skills/gstack-unfreeze/SKILL.md
skills/gstack-upgrade/SKILL.md
packages/browser/src/index.ts
packages/browser/src/lightpanda.ts
packages/browser/src/commands.ts
packages/browser/src/snapshots.ts
packages/browser/package.json
packages/browser/tsconfig.json
```

## Files to Modify

- `pnpm-workspace.yaml` - add `packages/browser`

## Success Criteria

1. All 21 gstack skills available in Paperclip
2. Skills work with all adapters (Claude, Codex, Cursor, Gemini, etc.)
3. Browser skills work with Lightpanda
4. Agents automatically detect and invoke appropriate skills
5. No breaking changes to existing Paperclip functionality

## References

- gstack repo: https://github.com/garrytan/gstack
- Lightpanda browser: https://github.com/lightpanda-io/browser
