---
name: "21st-ui-review"
description: "Review existing UI against the project's design context, accessibility expectations, responsive behavior, interaction quality, and high-confidence production rules."
key: "paperclipai/optional/agency-agents/21st-ui-review"
recommendedForRoles:
  - "designer"
  - "product"
tags:
  - "agency-agents"
  - "designer"
  - "product"
  - "21st"
  - "review"
defaultInstall: false
---
# Review UI with evidence

Separate deterministic defects from subjective design recommendations.

## Workflow

1. Read `.21st/design.json`, project instructions, and the relevant source.
2. Run the deterministic review first:

   ```bash
   21st review <path>
   21st review <path> --json
   ```

3. Inspect the actual component composition and runtime states. Validate claims
   against code rather than inferring behavior from names.
4. Group findings into:
   - deterministic defects;
   - design-system drift;
   - accessibility and interaction defects;
   - responsive risks;
   - subjective product/design recommendations.
5. Prioritize by user impact and include exact file and line attribution.
6. Use `21st review <path> --fix` only for deterministic, low-ambiguity fixes.
   Never silently redesign, change brand identity, or alter product behavior.
7. Run relevant project tests after fixes and rerun review to prove resolution.

## Review priorities

- semantic controls and accessible names;
- keyboard access, focus visibility, and dialog/menu behavior;
- image alternatives and meaningful labels;
- touch target size and disabled/loading states;
- responsive overflow and fixed-width assumptions;
- reduced-motion handling;
- hardcoded visual values that conflict with project tokens;
- duplicate primitives instead of existing components;
- inconsistent typography, radius, spacing, shadows, and icons;
- fake data, placeholder copy, or missing empty/error states.

## Output

Lead with actionable findings ordered by severity. Keep subjective suggestions
clearly labeled. If no issue is proven, say so and state what was inspected.
