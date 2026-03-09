# PR Report Style Guide

Use this guide when the user wants a report artifact, especially a webpage.

## Goal

Make the report feel like an editorial review, not an internal admin dashboard.
The page should make a long technical argument easy to scan without looking
generic or overdesigned.

## Visual Direction

Preferred tone:

- editorial
- warm
- serious
- high-contrast
- handcrafted, not corporate SaaS

Avoid:

- default app-shell layouts
- purple gradients on white
- generic card dashboards
- cramped pages with weak hierarchy
- novelty fonts that hurt readability

## Typography

Recommended pattern:

- one expressive serif or display face for major headings
- one sturdy sans-serif for body copy and UI labels

Good combinations:

- Newsreader + IBM Plex Sans
- Source Serif 4 + Instrument Sans
- Fraunces + Public Sans
- Libre Baskerville + Work Sans

Rules:

- headings should feel deliberate and large
- body copy should stay comfortable for long reading
- reference labels and badges should use smaller dense sans text

## Layout

Recommended structure:

- a sticky side or top navigation for long reports
- one strong hero summary at the top
- panel or paper-like sections for each major topic
- multi-column card grids for comparisons and strengths
- single-column body text for findings and recommendations

Use generous spacing. Long-form technical reports need breathing room.

## Color

Prefer muted paper-like backgrounds with one warm accent and one cool counterweight.

Suggested token categories:

- `--bg`
- `--paper`
- `--ink`
- `--muted`
- `--line`
- `--accent`
- `--good`
- `--warn`
- `--bad`

The accent should highlight navigation, badges, and important labels. Do not
let accent colors dominate body text.

## Useful UI Elements

Include small reusable styles for:

- summary metrics
- badges
- quotes or callouts
- finding cards
- severity labels
- reference labels
- comparison cards
- responsive two-column sections

## Motion

Keep motion restrained.

Good:

- soft fade/slide-in on first load
- hover response on nav items or cards

Bad:

- constant animation
- floating blobs
- decorative motion with no reading benefit

## Content Presentation

Even when the user wants design polish, clarity stays primary.

Good structure for long reports:

1. executive summary
2. what changed
3. tutorial explanation
4. strengths
5. findings
6. comparisons
7. recommendation

The exact headings can change. The important thing is to separate explanation
from judgment.

## References

Reference labels should be visually quiet but easy to spot.

Good pattern:

- small muted text
- monospace or compact sans
- keep them close to the paragraph they support

## Starter Usage

If you need a fast polished base, start from:

- `assets/html-report-starter.html`

Customize:

- fonts
- color tokens
- hero copy
- section ordering
- card density

Do not preserve the placeholder sections if they do not fit the actual report.
