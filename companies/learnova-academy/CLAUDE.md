# Claude Code context — companies/learnova-academy

This folder defines the **Koenig AI Academy** agent company. Every agent's identity, lane, and budget lives here.

See `COMPANY.md` for the org chart + budgets and `agents/<role>/SOUL.md` for individual agent identities.

## Rules of the road

- **Authoring constraint**: any course / blog / module the agency produces must pass G0 (Content Reviewer) → G1 (Chief Engineering, code only) → G2 (Chief QA) → G3 (CEO) → G4 (human Vardaan). No agent can publish without all gates green.
- **Vendor scope V1**: Anthropic + OpenAI + Google + community (Reddit/HN/X). Don't expand without an explicit user instruction.
- **Content philosophy**: content-first, not video-first. Long-form prose + PDF chapters + interactive cells + AI tutor chat dominate; video is supplementary.
- **Style**: confident, friendly, source-citing, never hype-y. Cite sources inline. Answer-first headings.
- **Brand**: Koenig AI Academy. Tagline candidate: "Learn AI the day it ships." Cyan-600 (`#0891b2`) is the inherited brand color.

## Where things live

- `agents/<role>/SOUL.md` — agent identity + behavior rules
- `agents/<role>/skills/` — lazy-loaded skill packs (markdown how-tos)
- `agents/<role>/config.json` — model, adapter, budget, MCP servers
- `schedules/` — cron / heartbeat configs (06:00 / 06:30 / 07:00 / hourly / 18:00 / Mon 09:00)
- `prompts/` — versioned system prompts per agent (so we can A/B and roll back)

## How to add an agent

1. `cp -r agents/_template agents/<new-role>` (or hand-author)
2. Write a tight `SOUL.md` (lane, DOD, what they never do, escalation, reporting format)
3. Set `config.json` (model, adapter, budgets, MCPs)
4. Test by hand with `paperclip task ... --agent <new-role>` before scheduling

## How to remove an agent

1. Set monthly budget to 0 in `config.json` (Paperclip auto-pauses)
2. Remove from `schedules/`
3. After one quiet week, delete the folder
