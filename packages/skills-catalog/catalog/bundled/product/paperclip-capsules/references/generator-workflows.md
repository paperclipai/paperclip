# Generator Workflows

Use this reference when the request is to generate Paperclip capsule graphics, capsule identicons, or reusable visual assets.

## Source Precedence

1. Brand authority: app, website brand guide, feature-video references, and hero-bank spec.
2. Deterministic identicon/profile-pill prototype:
   - `paperclip-content/design/PAP-11825/paperclip-capsule-identicon-prototyper/README.md`
   - `src/identicon.ts`
   - `src/App.tsx`
3. Website embedded generator:
   - `paperclip-website/public/brand/generator.js`
   - `paperclip-website/src/components/brand/sections/08-imagery.html`
4. Mirrored graphic-generator contract in this file.

The mirrored contract below was source-mined from the external prototype at commit `36a8a092c6ea6aa85bd0862bafb35ff9b9fab852`, but this skill must not depend on that personal repository being reachable. Treat the mode, palette, and control lists in this reference as the durable workflow contract.

## Choose a Workflow

| Need | Preferred workflow |
| --- | --- |
| Canonical hero brand image | Hero capsule bank reference |
| One agent's profile mark | Seeded identicon/profile-pill prototype; read `identicon-prototyper.md` |
| Repeatable marketing motif | External graphic-generator with explicit seed |
| Quick public-doc example | Website embedded generator |
| Product UI state | Existing `AgentCapsule` and status helpers |

## Website Embedded Generator

Templates:

- `blend-row`
- `chain`
- `bar-stack`
- `grid`
- `hero`
- `icon`

Palettes:

- `rainbow`
- `warm`
- `cool`
- `mono`
- `signal`
- `duotone`

Behavior:

- Uses a Mulberry32 seeded PRNG internally.
- Supports count, width, height, jitter, gap, and background parameters.
- Good for understanding public brand-guide templates and palettes.
- Weaker for issue deliverables because the UI does not expose seed/config as a first-class copyable control.

## Mirrored Graphic Generator Contract

Use this when the task needs reproducible generated capsule art beyond the small embedded website tool. The contract here is intentionally mirrored into Paperclip so agents can proceed if the original prototype repository is renamed, deleted, or private.

Known modes/templates:

- `blendRow`
- `icon`
- `chainLinks`
- `hero`
- `barStack`
- `grid`
- `wildcard`
- `manualBlend`
- `2d` and `3d` modes

Useful controls:

- Explicit numeric seed and reroll controls.
- Anchor palette override panel.
- Dither panel.
- Logo overlay panel.
- Background controls including images.
- PNG and SVG export.

If an implementation needs source code, prefer the Paperclip website embedded generator or a Paperclip-owned tool. Use any external prototype link only as optional historical context, not as required task input.

Palette caution:

- The `duotones` palette matches the website 12-preset capsule palette.
- Experimental palettes such as vaporwave, cyberpunk, ocean, and jewel are generator options, not canonical Paperclip brand palettes.
- Do not use experimental palettes when the request asks for strict Paperclip brand work.

## Deterministic Identicon / Profile Pill

Use `identicon-prototyper.md` when generating a reproducible capsule identity for one agent. That reference carries the detailed variant ids, HSL/OKLCH color schemes, dither algorithms, density/tone behavior, motion, share/export controls, and recommended combinations from the PAP-11825 prototype.

## Artifact Record Template

When generating assets for issue work, record this next to the attachment or deliverable:

```md
Capsule artifact

- Family: identicon | graphic-generator | hero-bank | individual-agent | heartbeat-status
- Workflow: website-generator | external-graphic-generator | identicon-prototype | hand-coded-svg | app-component
- Source path or tool commit:
- Seed:
- Template / variant:
- Palette / theme:
- Color space / color scheme:
- Density / count / dimensions:
- Motion / gradient angle:
- Output: SVG | PNG | HTML | MP4 | WebM
- Divergence from canonical Paperclip rendering:
```

## Review Checklist

- Is the output agent-related or the canonical hero-bank exception?
- Does the palette match the selected surface?
- Is the seed/config sufficient to reproduce the result?
- Are exports non-empty and inspectable?
- Are generated gradients confined to capsule shapes?
- If motion is included, is there a static/reduced-motion alternative?
