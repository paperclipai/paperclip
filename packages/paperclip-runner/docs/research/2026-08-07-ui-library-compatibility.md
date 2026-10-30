# 2026-08-07 shadcn/ui and AI Elements Compatibility

## Decision

Conformance adds no UI runtime and no shadcn/ui, AI Elements, React, Tailwind, Next.js,
or AI SDK dependency to `@paperclipai/paperclip-runner`. A later browser phase
should adapt source components selectively after protocol and reducer contracts
exist.

## Dated findings

Sources were checked on 2026-08-07.

| Surface | Finding | Runner decision |
|---|---|---|
| shadcn/ui | Official documentation describes open-code component distribution and provides first-class Vite and monorepo setup paths. | Compatible with Paperclip's Vite UI model. Reuse or adapt checked-in source while keeping Paperclip tokens and accessibility rules authoritative. |
| AI Elements | Official documentation describes a registry built on shadcn/ui, targets React 19 and Tailwind CSS 4, and lists Next.js plus AI SDK as prerequisites. | Source shapes are promising, but the documented turnkey setup does not match a standalone Vite runner console. Evaluate individual source components; do not adopt the Next.js/AI SDK runtime stack by default. |
| Conformance package | This phase has no browser surface. | Keep the dependency graph empty at runtime and defer all component selection. |

## Candidate later evaluation

When the browser phase is authorized, evaluate conversation/message,
prompt/composer, plan, tool, code, terminal, and queue-style source components
against these gates:

- data contract maps to the shared runner reducer rather than component-local
  state;
- styles use Paperclip's token layer with no raw color, spacing, radius,
  typography, shadow, or motion values in Paperclip UI files;
- keyboard and screen-reader behavior passes local accessibility review;
- Vite and Storybook builds do not require a Next.js runtime;
- no AI SDK dependency is added merely to render already-normalized runner data.

## Primary sources

- [shadcn/ui introduction](https://ui.shadcn.com/docs)
- [shadcn/ui Vite installation](https://ui.shadcn.com/docs/installation/vite)
- [Vercel AI Elements introduction and prerequisites](https://elements.ai-sdk.dev/docs)

This note is a compatibility record, not authorization to add a UI surface in
Conformance.
