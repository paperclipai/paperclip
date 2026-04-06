# Design Overhaul Plan -- Raava Dashboard

**Author:** Elena Voss, Head of Design
**Date:** 2026-04-06
**Target:** eMerge Americas Demo (April 22 -- 16 days)
**Audience:** Engineering pods, CEO, advisory council

---

## Executive Summary

The Raava dashboard has a solid DESIGN.md -- one of the better internal design specs I have seen. The token system is thoughtful (oklch, brand gradient, three typefaces with clear roles), the component patterns are well-documented, and the card-based layout philosophy is correct for the target user. The problem is not the spec. The problem is that the spec describes a product that does not yet exist on screen.

What is rendered today is a functional but emotionally flat dashboard. The brand gradient appears in a few places at 4-6% opacity. The welcome banner is a whisper when it should be a warm handshake. The status cards are plain boxes with dots. The overall feeling is "developer built this, and it works." For Carlos Mendez -- a logistics operator who wants to feel like he is managing a real team -- "works" is not enough. It needs to feel like opening the door to a well-run office.

After studying the best design systems (Linear, Stripe, Superhuman, Notion, Vercel), here is what separates good from great, and what Raava needs to close that gap.

---

## 1. Design Philosophy: What Raava Should Feel Like

**The North Star:** Notion's warmth meets Linear's precision, wrapped in Stripe's confidence.

Raava is not a developer tool. It is not an infrastructure dashboard. It is a **team management product** where the "team" happens to be AI. The design must communicate three things instantly:

1. **Warmth.** This is your team. Not your servers. Warm whites, soft shadows, human language. Notion nails this with their warm gray scale (`#f6f5f4`) and near-black text (`rgba(0,0,0,0.95)`) instead of pure black. Raava's DESIGN.md already specifies this philosophy -- but the components do not deliver it yet.

2. **Clarity.** A non-technical operator should understand what is happening within 3 seconds of seeing any page. Linear achieves this through relentless information hierarchy -- four tiers of text color, strict spacing, and zero visual noise. Raava needs the same discipline.

3. **Confidence.** The product should feel like it knows what it is doing, so Carlos does not have to. Stripe communicates this through their blue-tinted shadow system and weight-300 headlines -- light, calm, assured. Superhuman does it through restraint: one accent color, two border radii, product screenshots as proof. Raava should feel similarly self-assured.

**What Raava should NOT feel like:**

- A dark-themed developer IDE (no more dark mode as the default experience)
- A generic SaaS admin panel (no stock component library feel)
- A monitoring dashboard (no dense data grids, no terminal aesthetics)

---

## 2. Typography Audit

### What is working

- **Three-typeface system is correct.** Syne for display, Plus Jakarta Sans for body, JetBrains Mono for code. This is a good structure.
- **Syne at weight 800** for metrics and greetings gives Raava a distinct voice. Keep it.
- **Plus Jakarta Sans** is a solid workhorse. Legible, warm, professional.

### What needs to change

| Issue | Current | Recommended | Why |
|-------|---------|-------------|-----|
| Display type lacks presence | Syne at 22px for page titles | Syne at 28-32px for page titles, 22px for sub-headings | The best systems (Linear 72px, Stripe 56px, Superhuman 64px) use dramatically larger display type. Raava does not need to go that big inside a dashboard, but 22px is undersized for a welcome greeting. Scale up. |
| No letter-spacing on display type | Normal tracking throughout | -0.5px to -0.75px on Syne display sizes (24px+) | Every top-tier system uses negative tracking at display sizes. It creates density and confidence. Syne at 800 weight with slight compression will feel much more intentional. |
| Metric numbers too small | `text-2xl` (24px) on status cards | `text-3xl` (30px) or `text-4xl` (36px) with gradient text | The status count numbers are the first thing Carlos should see. They need to be large, bold, and use the brand gradient. Currently they are the same visual weight as body text. |
| Body text weight inconsistency | Mix of 400, 500, 600 without clear rules | 400 for reading, 500 for labels/UI, 600 for emphasis only | Tighten the weight usage. Too many `font-semibold` (600) applications make everything look the same weight. |
| Tabular numerals not applied | Specified in DESIGN.md but not enforced | Add `tabular-nums` class to all financial/metric displays globally | The spec calls for this. Enforce it. |

### Specific recommendations

1. Add a `tracking-tight` equivalent for Syne display text: `letter-spacing: -0.02em`
2. Create a `.raava-display` utility: `font-display text-[28px] tracking-[-0.02em] text-foreground`
3. Bump `.raava-stat-number` from 2.5rem to 2.75rem minimum, ensure gradient text is always applied
4. Reduce `font-semibold` usage by 50% across the codebase -- audit every instance

---

## 3. Color System Audit

### What is working

- **oklch color tokens** are future-proof and well-structured
- **Brand gradient** (`#224AE8 -> #716EFF -> #00BDB7`) is distinctive and memorable
- **Status color mappings** are comprehensive and well-documented
- **Light-mode-first** philosophy is correct for the target user

### What needs to change

| Issue | Current | Recommended | Why |
|-------|---------|-------------|-----|
| Brand gradient is barely visible | 4-6% opacity on welcome banner | 8-12% on welcome banner; 100% on primary CTA, nav indicator, stat numbers | The gradient is Raava's signature. It appears in the DESIGN.md gradient button variant, but the home page does not use it prominently. The stat numbers should always use `.raava-gradient-text`. The welcome banner gradient should be noticeable at a glance. |
| White cards on white background | Both `--background` and `--card` are `oklch(0.99 0 0)` | Keep card color the same but **enforce the shadow system** on every card | The DESIGN.md specifies a beautiful three-layer shadow (`.raava-card`), but cards without it look flat and indistinguishable from the background. Every card must use `.raava-card`. |
| Warm-white alternation not used | `--background-warm` defined but not applied | Apply to alternating sections on Home, Team Members, Tasks pages | This was inspired by Notion and it is the right call. Alternating warm/cool white sections create visual rhythm without borders. Implement it. |
| Dark mode border system incomplete | Dark mode borders specified but inconsistent application | Audit all cards in dark mode: ensure `.raava-card` dark variant uses `--border-default` consistently | The CSS defines `--border-subtle`, `--border-default`, `--border-prominent`, `--border-accent` for dark mode, but components use raw border classes. |
| Accent color underused | Teal (`#00BDB7`) defined but rarely appears | Use as selection ring, completed states, success confirmations, wizard completion | Teal is the "grounded" end of the gradient. It should signal completion and success throughout the product. |

### Key principle from the greats

Stripe uses ONE shadow color family (blue-tinted `rgba(50,50,93,0.25)`) that ties shadows to the brand palette. Raava's `.raava-card` shadow already does this with `rgba(50,50,93,0.12)`. This is good. The problem is that not every card uses `.raava-card`. Fix that.

---

## 4. Component System Audit

### Components that are fine (keep as-is)

| Component | Assessment |
|-----------|------------|
| **Button variants** | Well-structured with cva. The gradient variant is the hero. Keep it. |
| **Badge/Status pills** | Good color system, comprehensive status mapping. |
| **Dialog/Modal** | Radix-based, good animations, proper overlay. |
| **Input fields** | Clean, proper focus states, dark mode support. |
| **Tooltip** | Standard, works. |
| **Sidebar navigation** | The gradient indicator bar and active state are well-designed. |

### Components that need overhaul

| Component | Problem | Fix | Priority |
|-----------|---------|-----|----------|
| **Welcome Banner** | Too subtle. Reads as empty space, not a greeting. | Increase gradient opacity to 10-15%. Add a subtle illustration or team status summary inline. Consider showing "3 team members working right now" with animated dots. Make it feel alive. | P0 -- Demo |
| **Status Cards (metric strip)** | Flat boxes with small numbers. No visual hierarchy. | Numbers should be 36px+ Syne with gradient text. Cards should have distinct hover elevation. Add micro-animation on count change. Consider adding a subtle trend indicator (arrow up/down). | P0 -- Demo |
| **Team Member Cards** | Generic card grid. Avatar is a colored circle with an initial. No personality. | Add subtle gradient border on hover. Include current task as a one-liner below status. Show time-since-last-activity. Consider adding custom agent icons (the `AgentIconPicker` exists but is not used on cards). | P0 -- Demo |
| **Active Work section** | Plain text list. No visual connection to the team members doing the work. | Add avatar initials inline with each work item. Add a subtle progress indication. Add hover to navigate to the team member. Make it feel like watching your team work, not reading a log file. | P0 -- Demo |
| **Recent Tasks table** | Generic bordered list. Status badges are small and similar-looking. | Add left-border color coding by status (green stripe for done, blue for in-progress, red for stuck). Increase badge size slightly. Add relative timestamps ("2h ago"). | P1 -- Demo |
| **Spend This Week card** | The number is large but lacks context. No visual budget indicator. | Add a simple progress bar showing budget utilization. Color it green when under 70%, amber at 70-90%, red above 90%. This gives Carlos an instant read on spend health. | P1 -- Demo |
| **Onboarding Wizard** | Functional but not delightful. Role cards are plain. | Add hover animations to role cards. Polish the gradient border on selection. Add a subtle celebration animation on completion (confetti is too much -- a smooth gradient sweep is right). | P1 -- Demo |
| **Skeleton loaders** | Generic gray pulses. | Brand them. Use gradient shimmer that echoes the Raava gradient. Stripe and Linear both do branded skeleton loading. | P2 -- Post-eMerge |

### New components needed for demo

1. **Budget Progress Bar** -- horizontal bar with gradient fill, threshold color changes
2. **Team Activity Pulse** -- small animated indicator showing team is alive and working
3. **Trend Indicator** -- subtle up/down arrow with percentage for metric cards

---

## 5. Page-by-Page Priorities for eMerge Demo

### P0: Must be polished for April 22 (5 pages)

| Priority | Page | Current State | Target State |
|----------|------|---------------|--------------|
| 1 | **Home (RaavaHome.tsx)** | Functional but flat. See detailed breakdown below. | The "wow" moment. Carlos opens the dashboard and sees his team at a glance. Warm, alive, clear. |
| 2 | **Team Members list** | Card grid with avatars and status dots. | Each card should feel like a mini personnel file. Hover reveals current task. Status is prominent. Grid breathes with `gap-6`. |
| 3 | **Team Member Detail (RaavaTeamMemberDetail.tsx)** | Tab-based detail view. Chat, tasks, settings. | The "employee profile" page. Avatar is prominent. Status is clear. Chat feels like messaging a colleague. Overview shows current work + recent history at a glance. |
| 4 | **Onboarding Wizard (RaavaOnboardingWizard.tsx)** | 4-step wizard in a dialog. Role cards. | The "hiring experience." Should feel intentional and exciting, not like filling out a form. Role cards should have personality. The final "Launch" step should feel like a moment. |
| 5 | **Tasks (RaavaTasks.tsx)** | Task list view. | Clean, scannable. Status color-coding is immediate. Assignee avatars inline. Priority is visible. |

### P1: Should be improved but acceptable if time runs out

- Inbox (RaavaInbox.tsx)
- Costs page
- Task Detail (RaavaTaskDetail.tsx)

### P2: Post-eMerge polish

- Settings pages
- Activity page
- All remaining Paperclip-inherited pages (Dashboard.tsx, Agents.tsx, Issues.tsx, etc.)
- Dark mode comprehensive audit

---

## 6. Timeline: 2 Weeks to Demo

### Week 1 (April 7-11): Foundation + Home Page

| Day | Deliverable |
|-----|-------------|
| Mon-Tue | **Typography overhaul:** Update display sizes across all Raava pages. Add letter-spacing to Syne. Bump stat numbers. Audit font-weight usage. Create `.raava-display` utility. |
| Wed | **Card shadow enforcement:** Ensure every card in Raava pages uses `.raava-card`. Implement warm-white section alternation on Home. Increase welcome banner gradient opacity. |
| Thu | **Home page redesign:** Larger stat numbers with gradient text. Active Work section with avatars. Budget progress bar. Trend indicators. |
| Fri | **Home page polish:** Micro-animations on data refresh. Skeleton loader branding. Responsive testing. |

### Week 2 (April 14-18): Detail Pages + Onboarding

| Day | Deliverable |
|-----|-------------|
| Mon | **Team Members list:** Card hover states with gradient border. Agent icon display. Current task one-liner. Time-since-activity. |
| Tue | **Team Member Detail:** Profile header polish. Overview tab redesign. Chat tab visual polish. |
| Wed | **Onboarding Wizard:** Role card animations. Selection polish. Completion moment. |
| Thu | **Tasks page:** Status color-coding. Assignee avatars. Priority indicators. Recent Tasks table improvements. |
| Fri | **Integration testing + demo walkthrough.** Fix any visual inconsistencies. Test on the demo machine/projector resolution. |

### April 19-21: Buffer

Reserved for bug fixes, final polish, and demo rehearsal. No new features.

---

## 7. Before/After: Home Dashboard

### Current State

```
+-------------------------------------------------+
| Good morning, there.                      (22px)|
| Here's your team's status.                      |
| (barely visible gradient bg at 4% opacity)      |
+-------------------------------------------------+

+----------+  +----------+  +----------+
| * 3      |  | * 0      |  | * 0      |
| Active   |  | Idle     |  | Needs    |
|          |  |          |  | Attention|
+----------+  +----------+  +----------+

+--Active Work--------------------+  +--Spend-----+
| * Agent Name  Task desc    2h   |  | $12.40     |
| * Agent Name  Task desc    45m  |  | 34% of     |
| * Agent Name  Task desc    1h   |  | budget     |
+---------------------------------+  | View >     |
                                     +------------+

+--Recent Tasks-------------------------------+
| Task title    Agent     [Done]              |
| Task title    Agent     [In Progress]       |
| Task title    Agent     [Stuck]             |
+---------------------------------------------+
```

**Problems visible at a glance:**
- Welcome greeting is tiny and impersonal
- Status counts (3, 0, 0) are small and lack emphasis
- Active Work is a flat text list -- no visual connection to team members
- Spend card has a number but no visual context (is $12.40 good or bad?)
- Recent Tasks are a generic list -- status badges are small and similar

### Target State

```
+-------------------------------------------------+
| Good morning, Carlos.                     (28px)|
| 3 team members working right now  * * *         |
| (warm gradient bg at 12% opacity, team pulse)   |
+-------------------------------------------------+

+----------+  +----------+  +----------+
|    3     |  |    0     |  |    0     |
| (36px,   |  | (36px,   |  | (36px,  |
| gradient)|  |  gray)   |  |  gray)  |
|  Active  |  |  Idle    |  | Needs   |
|   ^12%   |  |          |  | Attn    |
+----------+  +----------+  +----------+

+--Active Work--------------------+  +--Spend-----+
| JH  Jordan   Following up..  2h|  | $12.40     |
| AX  Alex     Drafting prop. 45m|  | [====--] 34%|
| TY  Taylor   Reviewing...   1h |  | of $36 bgt |
|     (avatars, hover to detail)  |  | View >     |
+---------------------------------+  +------------+

+--Recent Tasks-------------------------------+
| | Task title    @Jordan      2h ago  [Done] |  <- green left border
| | Task title    @Alex        45m ago [WIP]  |  <- blue left border
| | Task title    @Taylor      1h ago  [Stuck]|  <- red left border
+---------------------------------------------+
```

### Specific changes

1. **Welcome Banner**
   - Greeting font size: 22px -> 28px
   - Add team activity summary: "3 team members working right now" with animated status dots
   - Gradient opacity: 6% -> 12%
   - Add subtle decorative element: thin gradient line at bottom of banner

2. **Status Cards**
   - Count number: 24px -> 36px, apply `.raava-gradient-text` to the Active count
   - Add trend micro-indicator ("^12%" in green if up from yesterday)
   - Card hover: elevate shadow, slight scale transform
   - Idle and Needs Attention counts use muted colors (gray, red) respectively

3. **Active Work**
   - Prepend avatar circle (initials, colored) to each row
   - Format agent name as bold, task as regular weight
   - Add `cursor-pointer` and navigate to team member on click
   - If no active work: show friendly empty state with CTA "Assign a task to get started"

4. **Spend This Week**
   - Add horizontal progress bar below the dollar amount
   - Color: gradient fill up to 70%, amber 70-90%, red 90%+
   - Show budget amount: "of $36.00 budget"

5. **Recent Tasks**
   - Add 3px left border to each row, color-coded by status
   - Add relative timestamp ("2h ago", "yesterday")
   - Agent name as `@name` link
   - Slightly larger status badges

---

## 8. Paperclip Residue to Eliminate

323 references to "Paperclip" across 142 files in the UI source. While most are in API layers and shared types (unavoidable for now), the following user-facing residue must be cleaned:

| Location | Issue | Fix |
|----------|-------|-----|
| CSS class names | `.paperclip-mention-chip`, `.paperclip-edit-in-place-content` | Rename to `.raava-mention-chip`, `.raava-edit-in-place-content` |
| Page components | `Dashboard.tsx`, `Agents.tsx`, `Issues.tsx`, `Inbox.tsx` are original Paperclip pages still in the route tree | Either remove from Raava routes or reskin. For demo, ensure they are not reachable from Raava navigation. |
| Shared types import | `import type { Issue } from "@paperclipai/shared"` | Acceptable -- this is a package dependency, not user-facing. Leave for now. |
| `OnboardingWizard.tsx` | Original Paperclip onboarding wizard still exists alongside `RaavaOnboardingWizard.tsx` | Ensure only Raava wizard is reachable in FleetOS mode. |

**Rule for demo:** No route accessible from the Raava sidebar should render a page that says "Paperclip" or looks like stock Paperclip.

---

## 9. Lessons from the Greats (Applied to Raava)

### From Linear: Information Hierarchy Through Luminance

Linear uses four tiers of text opacity on dark backgrounds. Raava should enforce three tiers on light backgrounds:
- `--foreground` (near-black): headings, names, primary data
- `--muted-foreground` (medium gray): descriptions, secondary text, timestamps
- An even lighter tier for placeholder and disabled states

Currently, too many elements use `text-foreground` when they should use `text-muted-foreground`, creating a wall of same-weight text.

### From Stripe: Shadows as Brand Expression

Stripe's blue-tinted shadows make even elevation feel on-brand. Raava's `.raava-card` shadow already includes `rgba(50,50,93,0.12)` -- this is correct. The task is enforcement: every elevated surface must use this shadow. No plain `shadow-sm` from stock Tailwind.

### From Superhuman: Radical Restraint

Superhuman uses ONE accent color, TWO border radii, and lets product screenshots do the selling. Raava's gradient is the one accent. The border radius should be simplified to two values: `8px` for small elements (buttons, badges, inputs) and `12px` for cards and containers. Currently the codebase mixes `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px), `rounded-2xl` (16px). Tighten this.

### From Notion: Warm Whites Create Comfort

Notion's warm gray scale (`#f6f5f4`) makes the interface feel like quality paper. Raava already defined `--background-warm` with this exact value. Use it. Alternate sections on long pages between `bg-background` and `bg-background-warm`. This creates visual rhythm without adding borders or dividers.

### From Vercel: Whitespace as Confidence

Vercel uses massive vertical padding (80-120px) between sections. In a dashboard context, Raava cannot be that generous, but the current `space-y-6` (24px) between major sections is too tight. Increase to `space-y-8` (32px) on the home page. Let the content breathe. A dashboard that feels cramped feels anxious. A dashboard that breathes feels in control.

---

## 10. Design Principles (New)

These supplement the existing DESIGN.md. They are the "why" behind every change above.

1. **Carlos should never feel confused.** Every screen answers "what is happening?" within 3 seconds. If he has to read a paragraph to understand status, we failed.

2. **The product is the team, not the dashboard.** UI chrome should be invisible. Team members, their status, their work -- that is what the eye goes to. Everything else (navigation, filters, settings) recedes.

3. **Warm, not cold. Confident, not loud.** Soft shadows, warm whites, generous spacing. No high-contrast borders. No neon status colors. No aggressive animations. The product should feel like a well-organized desk, not a trading floor.

4. **The gradient is the signature. Use it with intention.** Brand gradient appears on: primary CTA buttons, metric stat numbers, active nav indicator, onboarding wizard steps, and the welcome banner. That is the complete list. If it appears anywhere else, it is diluted.

5. **Every card earns its shadow.** The three-layer `.raava-card` shadow is the product's depth language. No card exists without it. No element gets a random `shadow-md` from Tailwind defaults.

---

*This plan was prepared based on a thorough audit of the current codebase, the existing DESIGN.md specification, and a comparative study of Linear, Stripe, Superhuman, Notion, and Vercel design systems from the awesome-design-md collection.*

*Ready for review. The team should treat this as the design brief for the next two sprints.*
