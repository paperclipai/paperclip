---
name: "21st-ui-build"
description: "Build or substantially change production UI using the current project's design context, existing components, and grounded 21st inspiration."
key: "paperclipai/optional/agency-agents/21st-ui-build"
recommendedForRoles:
  - "designer"
  - "product"
tags:
  - "agency-agents"
  - "designer"
  - "product"
  - "21st"
  - "build"
defaultInstall: false
---
# Build project-aware UI

Preserve the product's identity while using 21st supply to accelerate implementation.

## Workflow

1. Read `.21st/design.json` and `.21st/DESIGN.md`. If neither exists, run
   `21st init --design-context`.
2. Inspect the target route, its closest components, project instructions, and
   existing tokens. Treat explicit project facts as stronger than generic taste.
3. Search before generating:

   ```bash
   21st search "<specific UI need>" --context auto
   ```

4. Reuse installed project primitives first. Retrieve or install a 21st result
   only when it reduces duplication or materially improves the result.
5. If no result fits, generate project-aware alternatives:

   ```bash
   21st generate "<goal and constraints>" --context auto --variants 3
   ```

6. Implement the selected direction in the project's real framework. Do not
   paste sketch HTML when the project expects React components, tokens, or
   established APIs.
7. Preserve responsive behavior, keyboard interaction, visible focus,
   semantics, reduced motion, loading states, empty states, and error states.
8. Run the project's checks and `21st review <changed paths>`. Apply only safe,
   deterministic fixes automatically.

## Design rules

- Prefer project tokens over new arbitrary values.
- Prefer existing components over parallel lookalikes.
- Preserve established density, radii, typography, iconography, and layout
  rhythm unless the user explicitly requests a redesign.
- Use real product copy and states when available.
- Avoid decorative gradients, excessive cards, glass effects, huge headlines,
  and animation unless supported by the project or requested.
- Never claim a component, token, or capability exists without inspecting it.

## Handoff

Report the direction used, reused 21st/project components, files changed, and
verification performed. Record a durable visual choice in
`.21st/design.json` under `decisions` when the user selects a new direction.
