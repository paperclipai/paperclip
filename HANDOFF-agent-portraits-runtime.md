# Handoff → runtime session: build the agent identity layer (portraits + generated names)

**From:** design/UI session · **Date:** 2026-06-09 · **Priority:** MEDIUM — visible gap on the Agents roster / org chart / agent page; UI is already wired, so this is backend-only.

## TL;DR
The agent **"ID image"** (generated character portrait) is the one piece of the GLASSHOUSE identity layer that isn't live. The **design + spec are done**; the **UI is fully wired** (`<AgentPortrait>` on the roster, org nodes, and the agent page — it shows the living-eyes fallback until a portrait exists). What's missing is **runtime-only**: there's **no `portraitUrl` field on the Agent model** and **no generation pipeline**, so every portrait is forced to the eyes fallback. Stand up the pipeline in `docs/portrait-generation.md` and the images light up everywhere with zero further UI work.

Owner also added an **identity-generation requirement** (below): gender + name should be generated too, not just the image — and all three must be coherent.

## Current state
- **UI: done.** `ui/src/components/AgentPortrait.tsx` renders `<img src={portraitUrl}>` when present, else the animated `AgentFace` eyes. Used on the roster (`pages/Agents.tsx`), org nodes, and `AgentDetail`. The new **heartbeat-spine** also ships on the roster now (`480d7013`).
- **Spec: done.** Full pipeline, model choice (Imagen 4.0 Fast), endpoint, prompt template, diversity directive, storage path, cost, and a verified `curl` are in **`docs/portrait-generation.md`** — read that; it's the build sheet.
- **Backend: not built.** No `portraitUrl` (or `portrait`) column on the agent row / API; no generation job; `GEMINI_API_KEY` still only in `~/.management-os/env/shared.env` (migrate into ValAdrien OS Secrets + Railway).

## What to build (from the spec)
1. **Schema/API:** add `portraitUrl` (nullable, `company_id`-scoped like every row) to the agent model + expose it on the agent read API the UI already consumes.
2. **Pipeline:** on agent-create + a "regenerate portrait" action, async job → build persona → Imagen 4.0 Fast → store to `companies/<companyId>/agents/<agentId>.png` (Supabase Storage) → persist `portraitUrl`. Never block agent creation on the image; on failure leave null (UI shows eyes). All in `docs/portrait-generation.md`.

## NEW — identity generation requirements (owner, 2026-06-09)
Generate the **whole identity**, not just the picture, and keep it **coherent** (the name, the portrait, and the gender must agree — a masculine name must not get a feminine portrait):

1. **Random portrait.** Vary the persona per agent so a roster never looks cloned — randomize age, features, and **gender** across the company (the spec's diversity directive already says "vary age, gender, and features"; make it an explicit random draw per agent, not a fixed seed). Keep the shared `STYLE_SUFFIX` + dark-charcoal background identical so the company still reads as one coherent set.
2. **Gender — assign first, thread everywhere.** Draw a gender for the agent at identity-creation time, store it, and feed it into **both** the persona prompt **and** the name generation so the image and the name match. (Respect the tenant diversity directive — default pool is Caribbean / Latin American people of color — and keep gender balanced-ish across the roster, not all one.)
3. **Name from the position.** Generate/suggest the agent's display name from its **role/position + the chosen gender** (a CEO reads differently from a QA reviewer; a masculine identity gets a masculine name). This is for NEW agents / a "regenerate identity" action — don't rename the existing seeded roster (Ti Claude, Sol, Markét, Quill, Augur, Finch are set; their personas are in the spec table). Make the generated name editable (suggest, don't force).

**Coherence rule (the important one):** one identity draw produces `{ gender, name, persona → portrait }` together, from a single seed, so they can never drift apart. Don't generate the name and the portrait independently.

## Secrets / cost
`GEMINI_API_KEY` works for Imagen 4.0 (per the spec's empirical test). ~$0.02–0.04/portrait; a 6-agent company is ~$0.12–0.24 one-time. Migrate the key into ValAdrien OS Secrets + Railway and rotate per the standing security note. The OpenRouter key in `shared.env` is dead (401) — don't use it.

## Design side — nothing blocked on me
`AgentPortrait` + the roster heartbeat-spine are shipped and live. The moment `portraitUrl` is populated, the generated ID images appear on the roster, org chart, and agent page automatically. If you want a name-suggestion field in the create-agent UI once the generator exists, ping me and I'll wire the input.

— design/UI session
