# Design Inspiration Brief

> Produced by Pod Gamma (Amara Osei, Kai Andersen). Reference material for the frontend team when building and polishing Raava dashboard pages. Each pattern includes a cross-reference against our DESIGN.md.

---

## Linear --- What to Steal

### Pattern 1: Four-tier text hierarchy via subtle weight steps
**What they do:** Linear uses Inter Variable at weight 510 (between regular and medium) as its default emphasis weight, creating a nuanced hierarchy: 400 (reading) / 510 (UI emphasis) / 590 (strong emphasis). The 510 weight is the signature -- it adds subtle emphasis without the heaviness of semibold.
**Where we'd use it:** Sidebar nav labels, table column headers, card metadata labels. Anywhere we currently use `font-medium` (500) or `font-semibold` (600) and the result feels either too light or too heavy.
**Already in DESIGN.md?** Partially -- we use 400/500/600 weights for Plus Jakarta Sans, but we don't exploit the intermediate weight steps. Our system is coarser.
**Priority:** P3

### Pattern 2: Semi-transparent border system for dark mode
**What they do:** All borders in dark mode use `rgba(255,255,255,0.05)` to `rgba(255,255,255,0.08)` instead of solid dark colors. This creates structure that feels like "wireframes drawn in moonlight" -- present but never heavy. Borders adjust by increasing white opacity for more prominent elements.
**Where we'd use it:** Our dark mode card borders and dividers. Currently we use `oklch(0.269 0 0)` as a solid dark border. Switching to semi-transparent white borders would create more natural-looking containment in dark mode.
**Already in DESIGN.md?** No -- our dark mode borders are solid opaque values.
**Priority:** P2

### Pattern 3: Luminance-stepping for dark mode elevation
**What they do:** Instead of shadows (invisible on dark backgrounds), Linear steps background opacity up for elevated surfaces: `rgba(255,255,255, 0.02)` (base) to `0.04` (elevated) to `0.05` (prominent). Elevation is communicated through brightness, not shadow.
**Where we'd use it:** Dark mode card surfaces, popover backgrounds, dropdown menus. Would replace our current solid `oklch(0.205 0 0)` card background with a more layered approach.
**Already in DESIGN.md?** No -- our dark mode uses fixed oklch values for elevation. No translucent layering.
**Priority:** P2

---

## Stripe --- What to Steal

### Pattern 1: Blue-tinted multi-layer shadows for card elevation
**What they do:** Cards use `rgba(50,50,93,0.25) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px` -- a two-layer shadow where the far layer is tinted blue-gray (matching the brand palette) and the near layer is neutral. The negative spread values keep shadows vertically controlled. The result is elevation that feels brand-colored.
**Where we'd use it:** Team member cards on hover, the Welcome Banner card, any "featured" card state. Our current `shadow-md` hover is generic -- brand-tinted shadows would tie elevation to Raava's blue identity.
**Already in DESIGN.md?** No -- we use Tailwind's default `shadow-sm` and `shadow-md`. No brand-tinted shadows.
**Priority:** P1

### Pattern 2: Tabular numerals (`tnum`) for financial data
**What they do:** Stripe enables OpenType `font-feature-settings: "tnum"` on all financial data displays -- tables, metrics, charts. This makes digits monospaced so columns of numbers align perfectly, even when the rest of the font is proportional.
**Where we'd use it:** Billing page tables, metric cards on the dashboard (task counts, team member counts), any tabular number display. Plus Jakarta Sans supports `tnum`.
**Already in DESIGN.md?** No -- we use the default proportional numerals everywhere, including metric displays.
**Priority:** P1

### Pattern 3: Deep navy headings instead of near-black
**What they do:** Stripe uses `#061b31` (a very dark blue) for all headings instead of pure black or neutral near-black. The blue undertone adds warmth and a premium, financial-grade feel without being noticeable at first glance.
**Where we'd use it:** Not directly applicable -- Raava's brand warmth comes from our off-white canvas and warm gradient. But worth considering for the billing and settings pages where a "financial" tone would reinforce trust.
**Already in DESIGN.md?** No -- our `--foreground` is a neutral `oklch(0.15 0 0)`.
**Priority:** P3

---

## Vercel --- What to Steal

### Pattern 1: Shadow-as-border technique
**What they do:** Instead of CSS `border`, Vercel uses `box-shadow: 0px 0px 0px 1px rgba(0,0,0,0.08)` -- a zero-offset, zero-blur, 1px-spread shadow that acts as a border in the shadow layer. This avoids box model complications, enables smoother transitions, and creates subtler visual weight than traditional borders. Cards stack multiple shadow layers: border shadow + ambient elevation + inner `#fafafa` highlight ring.
**Where we'd use it:** Card containers, input fields, and any bordered element where we want smoother hover transitions. Our current `1px solid var(--border)` creates a hard line; shadow-borders allow cards to transition between border states without layout shift.
**Already in DESIGN.md?** No -- we use traditional CSS borders everywhere.
**Priority:** P2

### Pattern 2: Three-step deployment status pipeline with color-coded stages
**What they do:** Vercel's Develop (blue) / Preview (pink) / Ship (red) pipeline is a horizontal multi-step visual with each stage having its own accent color, connected by lines/arrows. Each step uses a monospace uppercase label + large title + description.
**Where we'd use it:** Task lifecycle visualization on team member detail pages or the tasks list. We could map our task statuses (Backlog / In Progress / In Review / Done) to a similar horizontal pipeline with our existing status colors, using JetBrains Mono uppercase labels for the stage names.
**Already in DESIGN.md?** Partially -- we have issue status circles with color-coding (blue/yellow/violet/green), but no horizontal pipeline component connecting them visually.
**Priority:** P2

### Pattern 3: Metric cards with compressed display type
**What they do:** Large metric display at 48px Geist weight 600 with extreme negative letter-spacing (-2.4px), a shadow-bordered card, and gray description text below. The aggressive tracking makes numbers feel engineered and high-density.
**Where we'd use it:** Our status metric strip on the home page. Currently we use `font-display text-2xl` (Syne 24px). We could tighten the letter-spacing on those metric numbers for a more engineered, information-dense feel.
**Already in DESIGN.md?** Partially -- we have the `.raava-stat-number` pattern (Syne 800, 2.5rem, gradient text), but no negative letter-spacing on metric displays.
**Priority:** P3

---

## Notion --- What to Steal

### Pattern 1: Warm white section alternation (`#f6f5f4`)
**What they do:** White content sections alternate with warm white (`#f6f5f4`) sections to create visual rhythm without introducing color. The warm tone carries a yellow-brown undertone -- like quality paper. This gentle alternation prevents page monotony without any borders or hard dividers.
**Where we'd use it:** Long pages like Settings, Billing, or the Team Members list. We could alternate between our `oklch(0.99 0 0)` background and a slightly warmer/darker tint for alternating content sections or table row groups.
**Already in DESIGN.md?** No -- we use a single background tone (`oklch(0.99 0 0)`) throughout. Our `--secondary` (`oklch(0.97 0 0)`) is close but lacks the warm undertone.
**Priority:** P1

### Pattern 2: Whisper borders at `rgba(0,0,0,0.1)`
**What they do:** All division borders are `1px solid rgba(0,0,0,0.1)` -- semi-transparent rather than a fixed gray. This means borders automatically adapt to any background color they sit on, getting slightly lighter on lighter backgrounds and slightly darker on darker ones. Cards, dividers, and section separators all use this single border value.
**Where we'd use it:** Everywhere we currently use `var(--border)`. The semi-transparent approach would simplify our border system and improve consistency across different background contexts (welcome banner, cards on muted backgrounds, etc.).
**Already in DESIGN.md?** No -- our `--border` is a fixed `oklch(0.922 0 0)` in light mode.
**Priority:** P2

### Pattern 3: Active button press with `scale(0.9)` transform
**What they do:** Buttons use `scale(0.9)` on active/pressed state and `scale(1.05)` on hover. This micro-animation creates a physical, tactile feel -- like pressing a real button. The transform is instant (no transition needed on active).
**Where we'd use it:** Primary CTA buttons (gradient button, "Hire Team Member"), dialog action buttons. Currently our buttons only have color/opacity hover states. Adding press feedback would make interactions feel more responsive.
**Already in DESIGN.md?** No -- our button states are limited to color transitions and opacity changes.
**Priority:** P2

---

## Cal.com --- What to Steal

### Pattern 1: Ring-shadow card elevation (shadow-as-border + contact shadow + diffused ambient)
**What they do:** Cards use a three-part composited shadow: `rgba(19,19,22,0.7) 0px 1px 5px -4px` (sharp contact shadow at bottom edge), `rgba(34,42,53,0.08) 0px 0px 0px 1px` (ring-shadow border), `rgba(34,42,53,0.05) 0px 4px 8px` (soft ambient). The contact shadow at 70% opacity but -4px spread creates a tight grounding line. The result is cards that feel like physical objects sitting on a surface.
**Where we'd use it:** Our `raava-card` component. Currently we use `0 2px 8px rgba(0,0,0,0.08)` + border. Cal's three-layer approach would give our cards more physicality, especially the sharp contact shadow for grounding.
**Already in DESIGN.md?** Partially -- we have a single-layer shadow + border. The multi-layer compositing approach is new.
**Priority:** P1

### Pattern 2: Inset highlight on buttons for 3D pressed effect
**What they do:** Buttons feature `rgba(255,255,255,0.15) 0px 2px 0px inset` -- a subtle white inner-top highlight that creates a 3D bevel effect, making the button look slightly domed. This is especially effective on dark buttons against light backgrounds.
**Where we'd use it:** Our gradient button and primary `bg-primary` button variants. The inset highlight would add a glass-like quality that elevates the button from flat to dimensional.
**Already in DESIGN.md?** No -- our buttons have no inset shadow treatment.
**Priority:** P2

### Pattern 3: Generous section spacing (80-96px between major sections)
**What they do:** Major content sections are separated by 80-96px of vertical space -- dramatically more than most SaaS dashboards. This creates a premium, breathable feel where each section stands on its own.
**Where we'd use it:** Not directly in the dashboard (where density matters), but on any marketing-adjacent pages (onboarding wizard, settings, billing overview). Our current `space-y-6` (24px) for page-level rhythm could be expanded on specific full-page views.
**Already in DESIGN.md?** No -- our largest documented gap is `p-8` (32px).
**Priority:** P3

---

## Supabase --- What to Steal

### Pattern 1: Border-based depth hierarchy (progressive border lightening)
**What they do:** Three tiers of border color create depth without any shadows: `#242424` (barely visible, recessed elements), `#2e2e2e` (standard card borders), `#363636` (prominent, interactive elements). The green brand accent border at `rgba(62,207,142,0.3)` serves as the "elevated/highlighted" state. This is especially effective in dark mode where shadows are invisible.
**Where we'd use it:** Our dark mode elevation system. Instead of relying on shadow differences that disappear in dark mode, we could define 3 tiers of border brightness plus a brand-accent border (using our primary blue at 30% opacity) for highlighted cards.
**Already in DESIGN.md?** No -- our dark mode uses a single border value `oklch(0.269 0 0)`.
**Priority:** P1

### Pattern 2: Monospace uppercase technical labels with wide tracking
**What they do:** Source Code Pro at 12px, `text-transform: uppercase`, `letter-spacing: 1.2px` for technical context markers -- labels like "DATABASE", "AUTH", "STORAGE". These labels act as section markers that connect the marketing site to the product's developer identity.
**Where we'd use it:** Section headers on technical pages (task logs, system status, API configuration). We have JetBrains Mono defined but underuse it. Uppercase tracked mono labels above technical sections ("TASK LOG", "SYSTEM STATUS", "CONFIGURATION") would reinforce that Raava is managing real infrastructure under the friendly surface.
**Already in DESIGN.md?** Partially -- we have JetBrains Mono defined for `--font-mono` but only use it for code blocks and IDs. No uppercase label pattern.
**Priority:** P2

### Pattern 3: Pill-shaped primary CTAs contrasted with standard-radius secondary buttons
**What they do:** Primary CTAs use 9999px radius (full pill) with generous 8px 32px padding and a white border on dark background. Secondary buttons use 6px radius. The shape difference alone creates a clear visual hierarchy -- you immediately know which button is primary.
**Where we'd use it:** We could adopt this for our gradient button (make it pill-shaped) versus our outline/secondary buttons (keep at 8px radius). Currently all our buttons share the same `rounded-md` radius, so hierarchy depends entirely on color.
**Already in DESIGN.md?** Partially -- we use `rounded-full` for badges and pills but all buttons use `rounded-md`.
**Priority:** P2

---

## Summary: Priority Matrix

### P1 --- Adopt Now (High impact, aligns with current build phase)

| Pattern | Source | Effort |
|---|---|---|
| Blue-tinted multi-layer card shadows | Stripe | Low -- CSS-only change to `raava-card` shadow |
| Tabular numerals (`tnum`) on metrics | Stripe | Low -- single CSS property on metric components |
| Warm white section alternation | Notion | Low -- define one new background token |
| Three-layer card shadow compositing | Cal.com | Low -- update `raava-card` shadow definition |
| Dark mode border depth hierarchy (3 tiers) | Supabase | Medium -- define 3 new dark border tokens |

### P2 --- Next Sprint (Meaningful improvement, moderate effort)

| Pattern | Source | Effort |
|---|---|---|
| Semi-transparent dark mode borders | Linear | Medium -- update dark mode border tokens |
| Dark mode luminance-stepping elevation | Linear | Medium -- refactor dark mode surface tokens |
| Shadow-as-border technique | Vercel | Medium -- replace CSS borders with shadow-borders |
| Task lifecycle pipeline visualization | Vercel | High -- new component |
| Whisper borders (`rgba(0,0,0,0.1)`) | Notion | Low -- change border token to semi-transparent |
| Active press `scale(0.9)` on buttons | Notion | Low -- CSS-only addition to button base |
| Inset highlight on primary buttons | Cal.com | Low -- CSS-only addition |
| Monospace uppercase section labels | Supabase | Low -- new utility class + usage |
| Pill-shaped primary CTA differentiation | Supabase | Low -- adjust gradient button radius |

### P3 --- Backlog (Nice to have, lower urgency)

| Pattern | Source | Effort |
|---|---|---|
| Intermediate font weight steps (510) | Linear | Medium -- requires variable font support |
| Deep navy heading tint for financial pages | Stripe | Low -- scoped color override |
| Negative letter-spacing on metric numbers | Vercel | Low -- CSS tweak |
| 80-96px section spacing on full pages | Cal.com | Low -- spacing adjustment on specific pages |
