---
name: paperclip-capsules
description: Generate, implement, or review Paperclip capsule visuals. Use for capsule art, agent capsules, heartbeat status capsules, identicons, capsule banks, or brand-usage validation.
key: paperclipai/bundled/product/paperclip-capsules
recommendedForRoles:
  - designer
  - product
  - engineer
  - marketing
tags:
  - paperclip
  - brand
  - capsules
  - agents
  - visual-design
  - hyperframes
---

# Paperclip Capsules

Use this skill when creating or checking Paperclip capsule visuals. The central rule is simple: **the capsule is the agent**. A capsule is not generic chrome, a button shape, a random status pill, or background decoration.

The one approved decorative exception is the canonical hero capsule bank. Treat it as a specific Paperclip brand surface, not a license to make arbitrary capsule wallpaper.

## When to Use

- Generating Paperclip capsule art, agent avatars, capsule fields, hero capsule banks, or seeded capsule identicons.
- Implementing an individual agent capsule in product UI.
- Rendering heartbeat status capsules for agent status.
- Building Paperclip feature videos or marketing graphics that use the capsule motif.
- Reviewing a design for capsule brand correctness.

## When Not to Use

- Generic rounded pills, badges, buttons, tags, nav items, or decorative blobs.
- Non-agent illustrations where capsules would only be visual texture.
- Product UI color choices unrelated to agents or heartbeat status.
- Replacing the app's existing `AgentCapsule` or status-color helpers from memory.

## Non-Negotiable Rules

- **Capsules represent agents.** If the surface does not involve agents, do not add capsules.
- **Do not use the agent capsule palette outside capsules.** Never apply agent gradients to buttons, text, page backgrounds, cards, or generic UI chrome.
- **Keep capsule families separate.** App individual capsules, heartbeat status capsules, website marketing capsules, video capsules, seeded identicons, and the hero bank have different data.
- **Hero bank is the only decorative exception.** Use the canonical bank spec; do not hand-roll a new bank.
- **Record reproducibility data.** For generated assets, record seed, template, palette, dimensions, and source workflow.
- **Respect reduced motion.** Any pulsing, blinking, breathing, wave, or fill-rise animation needs a static reduced-motion fallback.

## Choose the Right Capsule Surface

Use **individual agent capsules** when one capsule equals one agent in product UI, onboarding, org surfaces, or avatars. Read `references/individual-status-capsules.md` before implementing or changing UI behavior.

Use **heartbeat status capsules** for small solid status markers: idle/active gray, running blue pulse, paused amber, error red blink. These are not tall gradient identity capsules.

Use the **hero capsule bank** only for brand hero imagery, feature-video hero scenes, or approved marketing motif work. Read `references/hero-capsule-bank.md` before drawing it.

Use **graphic-generator layouts** when the task asks for capsule graphics such as blend rows, chains, grids, icon marks, or hero compositions. Prefer seeded tools and exportable workflows; read `references/generator-workflows.md`.

Use **seeded identicons/profile pills** when an agent needs a reproducible personal capsule mark. Read `references/identicon-prototyper.md` before choosing variants, color schemes, dither algorithms, density, sheen, aurora, mesh, motion, or exports.

## Implementation Workflow

1. Identify which capsule family you are working in: individual agent, status capsule, hero bank, generator layout, or identicon.
2. Load the matching reference file from this skill.
3. Prefer existing source implementations:
   - Product UI: `ui/src/components/AgentCapsule.tsx`, `ui/src/index.css`, and `ui/src/lib/status-colors.ts`.
   - Hero bank: canonical spec in `references/hero-capsule-bank.md`.
   - Video work: pair this skill with the Paperclip feature-video HyperFrames skill when available.
4. If generating an artifact, choose a reproducible workflow and write down the seed/config.
5. Verify that the result still reads as agent-related. Remove capsules if they became decoration.
6. Attach or otherwise expose generated deliverables when doing issue work, and name the exact workflow used.

## Output Expectations

For any generated capsule asset, include:

- Capsule family: `individual-agent`, `heartbeat-status`, `hero-bank`, `graphic-generator`, or `identicon`.
- Source workflow or implementation path.
- Seed and config where available.
- Dimensions, format, and renderer.
- Any divergence from canonical Paperclip rendering.

For code changes, include targeted checks that exercise the edited surface. For visuals, include screenshots or inspectable SVG/PNG/HTML when possible.

## Validation Checklist

- Does each capsule represent an agent, agent state, or the canonical hero-bank exception?
- Are gradients confined to capsule shapes?
- Are app, website, video, identicon, and hero-bank palettes kept separate?
- Is motion reduced or removed under reduced-motion settings?
- Is the source path or reproducible seed/config recorded?
- Are generated files attached or linked as inspectable deliverables for issue work?

## References

- `references/individual-status-capsules.md` - product app capsules, heartbeat status capsules, palette caveats, and reduced-motion rules.
- `references/hero-capsule-bank.md` - canonical hero-bank geometry, palette, grain, wave, crop, and rendering checklist.
- `references/generator-workflows.md` - website generator and external graphic-generator workflows.
- `references/identicon-prototyper.md` - deterministic profile-pill variants, color schemes, dither algorithms, density behavior, motion, export/share controls, and recommended combinations.
