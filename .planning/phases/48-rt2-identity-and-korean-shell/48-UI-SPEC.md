---
phase: 48
slug: rt2-identity-and-korean-shell
status: approved
shadcn_initialized: false
preset: existing-tailwind
created: 2026-04-30
---

# Phase 48 — UI Design Contract

> Visual and interaction contract for the RealTycoon2 identity shell cleanup.

## Design System

| Property | Value |
|----------|-------|
| Tool | none |
| Preset | existing Tailwind app shell |
| Component library | existing Radix/shadcn-style primitives |
| Icon library | lucide-react |
| Font | existing app font stack |

## Spacing Scale

Use the existing shell spacing. Do not introduce new layout primitives for this phase.

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon gaps, inline padding |
| sm | 8px | Compact nav/item spacing |
| md | 16px | Default page spacing |
| lg | 24px | Settings sections |

Exceptions: none.

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | existing `text-sm` | 400 | existing |
| Label | existing `text-xs`/`text-[13px]` | 500 | existing |
| Heading | existing `text-lg`/`text-xl` | 600 | existing |
| Display | not used | n/a | n/a |

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | existing `bg-background` | Shell surfaces |
| Secondary (30%) | existing `bg-card`, `bg-muted` | Settings/fallback cards |
| Accent (10%) | existing semantic accent/emerald brand mark | Active states and RT2 mark only |
| Destructive | existing `text-destructive` | Errors only |

Accent reserved for: active nav, RT2 compact mark, existing status badges.

## Copywriting Contract

| Element | Copy |
|---------|------|
| Product name | `RealTycoon2` |
| Primary CTA | `업무 추가` or `회사 추가` depending on context |
| Empty state heading | concise Korean statement of missing work/company/page |
| Empty state body | one Korean sentence with the next operational step |
| Error state | Korean problem + actionable next route/command |
| Help/docs label | `도움말` or `RealTycoon2 도움말` |
| Version label | `RealTycoon2 v{version}` |

## Interaction Contract

- Do not change route paths or redirect behavior.
- Do not add new modal flows.
- Do not introduce a landing page.
- Keep mobile nav compact and Korean.
- Keep settings pages utilitarian and dense.

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not required |
| third-party | none | not applicable |

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-04-30
