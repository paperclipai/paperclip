---
name: design-critique
description: Give a structured product design critique — user job clarity, hierarchy, affordance, error states, accessibility, and consistency — focused on what to change, in what order, and why.
key: paperclipai/optional/product/design-critique
recommendedForRoles:
  - designer
  - product
  - engineer
tags:
  - design
  - product
  - ux
  - review
---

# Product Design Critique

A structured critique pass for a screen, flow, or component. The output is a prioritized list of changes a designer or engineer can act on — not adjectives. Critique is not redesign; recommend, do not rebuild.

## When to use

- A designer or engineer asks for feedback on a screen, mock, or live UI.
- A feature is shipping and someone wants a final UX read.
- A flow is suspected of causing user drop-off and you want a pre-research read before instrumentation.

## When not to use

- The user wants a redesign. That is a design project, not a critique.
- The work is so early that no concrete artifact exists. Sketch with them instead of critiquing air.
- You have no context on the user job. Ask for it first; design critique without user context devolves into taste.

## Pre-critique context

Before opening a screen, get:

- **Who is the user.** Specific role and competence, not "users".
- **What job they are doing on this screen.** One sentence.
- **What success looks like.** What the user can do after this screen that they could not before.
- **Where this screen sits in the larger flow.** What precedes and follows.

If any of these is missing, ask. Critique without these is opinion.

## The pass (in order)

1. **Clarity of the user job.**
   - Within 3 seconds of opening, is it obvious what this screen is for?
   - Does the primary action match the user's actual job, or a designer's preferred path?

2. **Visual hierarchy.**
   - The most important thing on the screen should be the most prominent (size, weight, position, color).
   - Secondary actions should look secondary. Tertiary should be findable but not loud.
   - Headings should chunk content into the right groups for the task.

3. **Affordance and signifiers.**
   - Clickable things look clickable.
   - Disabled things look disabled and explain why on hover/focus.
   - Drag, scroll, or swipe interactions are discoverable, not hidden.

4. **States.**
   - Empty state (no data) is designed, not a blank rectangle.
   - Loading state communicates progress, not just spins.
   - Error states say what went wrong and what to do next, in the user's words.
   - Success state confirms without celebrating banal actions.

5. **Inputs and forms.**
   - Labels visible, not just placeholders.
   - Validation runs at the right time (on blur, not on every keystroke unless the user is in a known-format field).
   - Required fields marked.
   - Field order matches the user's mental order, not the database order.

6. **Accessibility.**
   - Sufficient color contrast (WCAG AA at minimum; AAA where reasonable).
   - Focus order is logical for keyboard navigation.
   - Interactive elements are reachable without a mouse.
   - Critical information is not color-only (icons, text, position back it up).
   - Touch targets at least 44×44 px on mobile.

7. **Consistency.**
   - Tokens, components, and patterns match the rest of the product.
   - "Borrowed" patterns from other products are intentional, not accidental drift.

8. **Copy.**
   - Buttons are verbs that name the outcome ("Save changes" beats "Submit").
   - Microcopy explains, does not decorate.
   - Tone matches the product voice.

9. **Edge cases.**
   - Long content (long names, many items, RTL languages).
   - Tiny content (one item, zero items).
   - Slow network and offline behavior.
   - Permissions denied.

## Output format

Group findings by severity, then by category. Each finding is one issue and one suggested fix.

```md
## Design critique: <screen name>

### Must-fix (blocks ship)
- **<category>:** <one-line issue>. **Try:** <one-line suggestion>.

### Should-fix (before broader rollout)
- **<category>:** <one-line issue>. **Try:** <one-line suggestion>.

### Nice-to-fix (when there's room)
- **<category>:** <one-line issue>. **Try:** <one-line suggestion>.

### Strengths to keep
- <one-line thing the design got right>
```

Always include the "strengths to keep" section. It is not flattery — it is signal to the designer about what not to change in the next round.

## Anti-patterns

- "I would do it differently" without saying what or why. That is preference, not critique.
- Long critiques that bury must-fix items under nice-to-haves.
- Suggesting net-new features under the guise of a critique.
- Ignoring user context and grading on taste.
- Treating a critique as approval. State approval explicitly if asked; otherwise critique is feedback, not sign-off.
