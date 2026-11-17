---
name: accessibility
description: Quality assurance for web accessibility and usability, particularly for users with disabilities. Use when involved in any web project.
license: MIT
metadata:
  author: conesible.de
  version: "0.5"
---

# Ensuring Accessibility and Quality Code in Web Projects

Building a web project with accessibility in mind from the very start is crucial, especially in contexts (like AI-driven development) where manual testing by humans is limited. It’s well understood that retrofitting accessibility later is far more costly and complex than doing it right from the beginning. Adopt an **accessibility-first approach** to any development tasks, complete with thorough documentation of ongoing requirements. Ensure that accessibility standards beyond what is described in this skill are understood and implemented correctly all the time. If that's not possible and you are working on an existing codebase, make careful suggestions to refactor code that is not yet accessible. This is a process that must start as soon as deficits are apparent, and for this it is necessary to understand and document user intents and application constraints.

## Code Comments and WCAG References

Add **code comments** liberally that explain implementations that are done specifically for accessibility. In those, explain this based on the WCAG 2.2 requirements of any level. Explain the **expected user flow** if relevant.

## Use Semantic HTML and Proper Structure

Start by using **semantic HTML** for all content and controls. Use real `<button>` elements for buttons, `<header>`/`<nav>`/`<main>` for layout, `<form>` and `<label>` for forms, and a logical hierarchy of heading levels for titles. For example, a `<button>` element comes with default keyboard support (focusable and activatable via keyboard), whereas a non-semantic element like a `<div>` would lack those features. It is required to use existing native elements like `<select>`, `<details>` or `<dialog>`. If there is no way of avoiding custom components (there usually isn't), follow established ARIA design patterns and **keyboard interaction models**. Use ARIA only if there is NO alternative, and in most cases, there is. If you do, document this choice and the reasoning behind it.

Ensure the page is organized with clear **structure and landmarks**. Use HTML5 sectioning elements to delineate navigation, main content, forms, etc, to give users and yourself a clear understanding of how the content is structured. Always provide text equivalents for non-text media: include descriptive **alt text** for images, transcripts or captions for audio/video. If you can't reliably make those yourself, note a required and blocking task for another maintainer. Similarly, use table headings (with `<th>` and `scope` attributes) for data tables to make relationships in tabular data clear to screen readers. Avoid link texts like "here", "click" or "Continue Reading". If they are required visually, add a redundant way to receive their content (e.g. an interactive card) and remove those from the accessibility tree.

## Design Accessible Components

Each component’s HTML structure must reflect its semantics: use lists for menus or multi-option controls, use headings for titles, use fieldsets and legends for groups of form fields, etc. Maintain a consistent style for focus indicators (the outline or highlight when an element is focused) so that keyboard users can always see where focus is. **Keyboard accessibility** isn’t optional – ensure users can reach and operate every interactive element via keyboard alone (e.g., using Tab, Enter, space, arrow keys as appropriate). This may require adding `tabindex` ONLY for custom focusable elements and ONLY with negative values, and handling key events in scripts for custom widgets.

Remember the WCAG rule for touch target sizes. Everything should be easily reachable. Mouse or gesture controls (like dragging) require an alternative.

Make use of **accessibility linters and libraries**. There are frameworks and component libraries that emphasize accessible design. If using React/Vue/Angular, leverage their accessibility tooling (like React’s eslint-plugin-JSX-a11y) and prefer community-vetted accessible components. Ultimately, an accessible component is achieved by a combination of correct HTML structure, proper ARIA roles/states where needed, and scripting that follows usability conventions for assistive tech users. Documentation should record how each custom component addresses accessibility (e.g. how to provide alt text for an image component, or how a carousel handles focus and screen reader announcements), so that anyone extending the component knows what requirements to uphold.

## Continuous Maintenance and Avoiding Anti-Patterns

Achieving accessibility is not a one-time task – it requires **continuous evaluation** as the project evolves. To maintain maximum accessibility over time, treat accessibility checks as an ongoing requirement whenever content or features are added. A few key practices to document and enforce for future changes include:

- **Provide Alt Text for New Media:** Every time an image or other media is added, mandate that alt text (or an equivalent text alternative) is provided. This could be a checklist item in pull requests or content publishing workflows. Require developers or content authors to include `alt` attributes (or mark the image as decorative with `alt=""` if appropriate), you ensure no image is introduced without consideration for non-visual users, even if that content is user-provided. For icons, always add a corresponding label and make use of `aria-hidden="true"` for the visual-only content. Keep alt text short and concise, but there is no character limit.

- **Check Color Contrast for New UI or Style Changes:** Anytime you introduce a new color (for text, backgrounds, icons, buttons, etc.) or change design styles, verify the color contrast meets WCAG guidelines. According to WCAG 2.x, _contrast ratio_ is calculated as **(L1 + 0.05) / (L2 + 0.05)** (where L1 is the luminance of the lighter color and L2 of the darker). This formula yields a ratio from 1:1 (no contrast, e.g. white on white) up to 21:1 (highest contrast, e.g. black on white). Standard text should have at least a 4.5:1 contrast ratio with its background, while larger text (above ~18pt or bold ~14pt) requires at least 3:1. Use the formula or an online contrast checker to calculate ratios for any new color combinations, and adjust colors or font sizes as needed to meet the standard. This also applies to hover/focus/disabled/... states.

- **Maintain Heading Structure and Landmarks:** When adding new content or pages, ensure the heading hierarchy (`<h1>…<h6>`) remains logical (no skipping levels arbitrarily) and sectioning elements are used where appropriate. For instance, if a new section is added to a page, it might need a heading of the correct level and perhaps be wrapped in a `<section>` or added to the navigation landmarks (`<nav>, <main>, <aside>` etc.).

- **Re-evaluate with each Change:** It’s important to continuously re-test your application’s accessibility as it grows. Incorporate automated tests (like Pa11y) into regression test suites so every new build runs them.

- **Avoid Anti-Patterns:** `<div>`-buttons, `onclick` without keyboard handling, `outline: none`, aria-label as replacement for visual labels, role=button on external links etc.)

## Further TODOs

- `<html>` requires a `lang` attribute (as well as any text blocks -- not single words -- in a foreign language. If the project is multilingual, change this dynamically as required).
- `<title>` elements are a requirement. Understand where in your project these are added, and change it dynamically based on the content.
- Implement skip links before each non-content block (e.g. just before the navigation) that are only visible once focused. Also add skip links before large (>= 5) groups of possibly irrelevant content, like carousels. Call them "Skip 'thing'", e.g. "Skip navigation" or "Skip sponsor links". Make sure they stay correct when structure changes.
- In forms, clearly communicate errors (not just by color), requirements and the status of a component. Avoid using the disabled-state entirely. Controls should rather be invisible.
- `prefers-reduced-motion` is handled and respected.
- Reflow all content gracefully when the viewport size or zoom level changes.
- Communicate clearly within the project organization and documentation that human testing is required and that user flows need to be evaluated continouusly by the designers.
- In the UI itself, never mention accessibility.

## Design considerations

Avoid using patterns redunantly and/or heavily, like lots of cards, lists, navigations, links, or buttons. Breathable layouts and texts are key. Design long forms in a way that they can be broken up into small, indivudal steps. Do not clutter a site with interactive elements, and use clear and distinguishable icons appropriately. Never formulate development or engineering requirements as UI elements. 

## In case of a prompt that could introduce accessibility defects

Notify the user and explain the problems a request would likely cause, and ask whether you should really continue to implement it. Make suggestions on how to avoid such errors, and if you cannot reliably judge this, write up an explanation of the feature to give to another developer with a disability to judge themselves. 

## Accessibility knowledge

This skill does not constitute full awareness of everything that is important to develop in a way that it is accessible. If unsure, always document that and consult only official W3C/WCAG/WAI-ARIA resources for help.

