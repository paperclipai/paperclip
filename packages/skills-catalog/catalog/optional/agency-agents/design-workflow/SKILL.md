---
name: "design-workflow"
description: "Anti-AI-generic design guidelines. Use when creating UI prototypes, reviewing designs for generic AI patterns, or setting up a project design system."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/design-workflow"
recommendedForRoles:
  - "designer"
  - "operations"
tags:
  - "agency-agents"
  - "designer"
  - "operations"
  - "design"
  - "workflow"
defaultInstall: false
---
# Design Workflow Skill

Guidelines for making UI designs that don't look AI-generated. These rules apply to any design work — prototypes, design docs, or UI code.

## What This Skill Does

1. Teaches how to avoid "generic AI" design patterns
2. Provides a checklist for design quality
3. Guides component-by-component design approach
4. Sets prototype quality standards

## Rule 1: Use the Existing Design System

**NEVER invent new colors, fonts, or spacing.** Always use what the project defines.

### What to Read FIRST
1. `.planning/design-config.md` — project colors, fonts, spacing, brand identity
2. The theme files listed in design-config — actual CSS tokens
3. Existing components in the codebase — match their patterns

### Key Points
- Use EXACT hex values from the project palette (not Tailwind defaults like `bg-blue-500`)
- Use the project's font — don't swap in Inter, Poppins, or Space Grotesk
- Use the project's border radius and shadow values
- Reference CSS variables or tokens — don't hardcode

---

## Rule 2: Avoid Generic AI Patterns

These patterns scream "AI made this" — avoid them ALL:

### Colors
- Don't use colors outside the project palette
- No random purple/violet gradients (the #1 AI cliche)
- No neon colors or rainbow gradients
- No gray-on-gray with no accent color
- Use the project's accent color — that's what makes it unique

### Layout
- No centered-everything-with-max-width-on-every-section
- No hero with a giant gradient blob behind text
- No three-column feature cards with icons that all look the same
- No 50/50 split with image on right, text on left (for every section)
- Break the grid sometimes — asymmetry is more interesting

### Typography
- No single font size for everything
- Create clear hierarchy: big headings, medium subheads, small body
- Use font weight contrast
- Don't center-align long text blocks

### Components
- No rounded rectangles that all look identical
- Give cards visual variety — different sizes, featured vs normal
- Buttons should have clear primary/secondary/ghost hierarchy
- Don't use icons for everything — sometimes text is better

### Copy
- No generic marketing fluff ("Unlock your potential", "Take it to the next level")
- Be specific — use real feature names and real numbers
- Match the tone from design-config's Design Personality

---

## Rule 3: Design Component by Component

Don't design a whole page at once. Build pieces, then compose.

### Order of Work
1. **Design tokens** — Confirm colors, fonts, spacing from existing theme files
2. **Base components** — Button, Card, Badge, Input (small, isolated)
3. **Composite components** — Nav bar, Sidebar, Hero section, Feature card
4. **Full screens** — Compose components into pages
5. **States** — Add loading, empty, error states to each component
6. **Responsive** — Adjust each screen for mobile/tablet/desktop

---

## Rule 4: Use Visual References

When references are given:
1. Study what makes it look good (layout, color, typography, whitespace)
2. Take inspiration, don't copy — match the quality level, not the exact layout
3. Apply to the project's design system

When NO references are given:
- Check Reference Apps in design-config
- Focus on whitespace — more space = more premium
- Use accent color sparingly — max 10-15% of the screen
- Make one thing big and bold per section (hierarchy)

---

## Rule 5: Prototype Quality Standards

### Must Have
- Exact colors from the project theme files
- Real fonts loaded
- Proper spacing (not random padding everywhere)
- Real content (not "Lorem ipsum")
- All states visible (loading, empty, error, success)
- Responsive: works at 375px, 768px, 1440px

### Must NOT Have
- Placeholder images or stock photo URLs
- Default Tailwind colors
- Missing hover/focus states
- Broken layout at any viewport
- Text that's hard to read (check contrast)

---

## Review & Checklists

> See checklists.md for the self-check, critic review checklists, and design-implementation mismatch troubleshooting.
