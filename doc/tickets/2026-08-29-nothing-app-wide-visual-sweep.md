# Extend the Nothing-inspired visual system across the app

Date: 2026-08-29
Status: planned — dashboard first slice is tracked separately in issue #26

## Problem

The dashboard can share one visual language while the rest of the application still contains independent palette, spacing, typography, gradient, and shadow decisions. That makes navigation between the dashboard, organization/company views, work surfaces, cycles, settings, and developer tools feel like switching products.

The current token gate is useful as an inventory signal, but the remaining violations need product-level grouping and visual review rather than a blind global codemod. The last baseline reported 4 color-literal, 170 arbitrary-value, and 96 raw-font-size violations after the dashboard slice; most are outside the dashboard and several are functional or third-party exceptions.

## Direction

- Extend the approved Nothing-inspired language: neutral surfaces, precise borders, dotted machine values, restrained motion, and semantic status accents.
- Keep one token source in `ui/src/index.css`; use semantic roles instead of local Tailwind palette names.
- Preserve functional color values used for persisted data, canvas/terminal configuration, and third-party integrations through documented allowlists.
- Treat organization/company hierarchy, task semantics, and page information architecture as product contracts; visual consistency must not rename or flatten them.

## Suggested work batches

1. Shell: sidebar, organization/company switcher, top bars, mobile navigation, and breadcrumbs.
2. Work: tasks, Epics, AI execution, human acceptance, cycles, and work overview.
3. Resource pages: organizations, companies, projects, settings, and costs/usage details.
4. Operator tools: browser/runtime surfaces, Smoke Lab, plugin slots, and custom dashboard builder.
5. Typography/motion cleanup: migrate remaining raw type and visual values, then review the allowlist.

## Acceptance criteria

- A user can move through the primary app surfaces without unrelated blue/purple/gray chrome or competing card treatments.
- Status and severity colors remain semantically consistent and accessible across pages.
- Every migrated visual value resolves through the token layer; intentional functional exceptions remain documented.
- Light and dark themes are reviewed for contrast and responsive behavior.
- Each batch has focused tests or snapshots and passes the token gate for the files it owns.
- No hierarchy, routing, API, permission, or workflow behavior changes as part of the visual sweep.

## Non-goals

This is not a brand rename, information-architecture rewrite, or replacement for the Organization/company hierarchy issue. It does not change agent execution, quota calculations, or persisted color data.
