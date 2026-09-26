---
name: "design-intelligence"
description: "Design system bootstrapping and token generation. Takes project context and outputs ready-to-use design tokens, Tailwind config, and CSS variables."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebSearch
key: "paperclipai/optional/agency-agents/design-intelligence"
recommendedForRoles:
  - "designer"
tags:
  - "agency-agents"
  - "designer"
  - "design"
  - "intelligence"
defaultInstall: false
---
# Design Intelligence — Token Generation & Design System Bootstrapping

This skill helps set up design systems from scratch. Give it your project context (industry, brand, users) and it generates ready-to-use design tokens with Tailwind config snippets and CSS variable files.

## When to Use

- Setting up a new project's design system (`/spartan:ux system`)
- Choosing color palettes for a specific industry/brand
- Generating typography scales
- Creating spacing systems
- Bootstrapping a component inventory

## What This Skill Does

1. Takes project context (what, who, industry, personality)
2. Generates a complete design token set
3. Outputs in 3 formats: token reference doc, Tailwind config, CSS variables
4. Creates a component inventory based on the project type

## How It Works

### Step 1: Gather Context

Ask these questions (skip any the user already answered):

1. **What are you building?** (dashboard, SaaS, marketplace, mobile app, landing page, etc.)
2. **Who uses it?** (developers, business users, consumers, admins)
3. **What's the personality?** Pick 2-3:
   - Clean / Professional / Corporate
   - Bold / Playful / Creative
   - Minimal / Technical / Developer-focused
   - Warm / Friendly / Approachable
   - Premium / Luxury / Refined
   - Data-heavy / Dense / Information-rich
4. **Light, dark, or both?**
5. **Any brand colors already decided?** (if yes, use those as the foundation)
6. **Reference apps?** (apps that have the quality you want)

### Step 2: Generate Color Palette

Based on the context, generate a complete palette:

**For dark themes:**
```
Background:     #0F172A (slate-900 family)
Surface:        rgba(30, 41, 59, 0.5) (glass effect)
Primary:        [based on personality — blue for professional, green for growth, etc.]
Primary Hover:  [10% darker]
Accent:         [complementary or analogous — use sparingly, max 10-15%]
Text:           #F8FAFC (near white)
Text Secondary: #94A3B8 (slate-400)
Text Muted:     #64748B (slate-500)
Border:         rgba(148, 163, 184, 0.1)
Success:        #22C55E
Warning:        #F59E0B
Error:          #EF4444
```

**For light themes:**
```
Background:     #FFFFFF or #F8FAFC
Surface:        #FFFFFF
Primary:        [based on personality]
Primary Hover:  [10% darker]
Accent:         [complementary]
Text:           #0F172A (near black)
Text Secondary: #475569 (slate-600)
Text Muted:     #64748B (slate-500)
Border:         #E2E8F0 (slate-200)
Success:        #16A34A
Warning:        #D97706
Error:          #DC2626
```

**Color selection by personality:**

| Personality | Primary range | Accent range |
|-------------|--------------|-------------|
| Professional / Corporate | Blue (#2563EB → #1E40AF) | Slate or Amber |
| Bold / Creative | Purple (#7C3AED), Pink (#EC4899) | Yellow or Cyan |
| Minimal / Technical | Gray (#374151), Black (#111827) | One bright accent |
| Warm / Friendly | Orange (#EA580C), Teal (#0D9488) | Amber or Rose |
| Premium / Luxury | Deep Blue (#1E3A5F), Gold (#B8860B) | Silver or Champagne |
| Data-heavy | Neutral blue (#3B82F6) | Green for positive, Red for negative |

### Step 3: Generate Typography Scale

Pick a font pairing based on personality:

| Personality | Font recommendation | Why |
|-------------|-------------------|-----|
| Professional | DM Sans, Plus Jakarta Sans | Clean geometric, good for UI |
| Technical | JetBrains Mono (code) + Inter (UI) | Developer-friendly |
| Creative | Outfit, Space Grotesk | Distinctive but readable |
| Warm | Nunito, Quicksand | Rounded, friendly feel |
| Premium | Playfair Display (headings) + Lato (body) | Elegant contrast |
| Data-heavy | Inter, Roboto Mono (numbers) | Tabular nums, high readability |

**Type scale (base 16px):**
```
h1: 36px / 700 / 1.2 line-height
h2: 30px / 700 / 1.25
h3: 24px / 600 / 1.3
h4: 20px / 600 / 1.35
h5: 18px / 600 / 1.4
h6: 16px / 600 / 1.4
body: 16px / 400 / 1.6
body-sm: 14px / 400 / 1.5
caption: 12px / 500 / 1.4
```

### Step 4: Generate Spacing & Radius

**Spacing scale (8px base):**
```
xs:   4px   (0.25rem)
sm:   8px   (0.5rem)
md:   16px  (1rem)
lg:   24px  (1.5rem)
xl:   32px  (2rem)
2xl:  48px  (3rem)
3xl:  64px  (4rem)
```

**Radius by personality:**

| Personality | Card | Button | Badge | Input |
|-------------|------|--------|-------|-------|
| Professional | 8px | 6px | 4px | 6px |
| Minimal | 0-4px | 4px | 2px | 4px |
| Friendly | 12-16px | 8px | 9999px | 8px |
| Premium | 12px | 8px | 6px | 8px |

**Shadow by personality:**

| Personality | Style |
|-------------|-------|
| Professional | Subtle: `0 1px 3px rgba(0,0,0,0.1)` |
| Minimal | None or very subtle borders |
| Friendly | Soft: `0 4px 12px rgba(0,0,0,0.08)` |
| Premium | Layered: `0 1px 2px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.08)` |
| Dark theme | Glow: `0 0 20px rgba(primary, 0.15)` |

### Step 5: Output in 3 Formats

#### Format 1: Token Reference Doc (`.planning/design/system/tokens.md`)

Human-readable markdown with all tokens, used by designers and all commands.

#### Format 2: Tailwind Config Snippet

```typescript
// Paste into tailwind.config.ts → theme.extend
{
  colors: {
    primary: '[value]',
    'primary-hover': '[value]',
    accent: '[value]',
    background: '[value]',
    surface: '[value]',
    // ... all color tokens
  },
  fontFamily: {
    sans: ['[font]', 'sans-serif'],
  },
  borderRadius: {
    card: '[value]',
    button: '[value]',
  },
  boxShadow: {
    card: '[value]',
  },
}
```

#### Format 3: CSS Variables

```css
:root {
  /* Colors */
  --color-primary: [value];
  --color-primary-hover: [value];
  --color-accent: [value];
  --color-bg: [value];
  --color-surface: [value];
  --color-text: [value];
  --color-text-secondary: [value];
  --color-text-muted: [value];
  --color-border: [value];
  --color-success: [value];
  --color-warning: [value];
  --color-error: [value];

  /* Typography */
  --font-family: '[font]', sans-serif;
  --font-size-h1: 36px;
  /* ... full scale */

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;

  /* Radius */
  --radius-card: [value];
  --radius-button: [value];
  --radius-badge: [value];

  /* Shadows */
  --shadow-sm: [value];
  --shadow-md: [value];
  --shadow-lg: [value];
}
```

### Step 6: Generate Component Inventory

Based on the project type, list the components needed:

**Dashboard / SaaS:**
- Sidebar navigation, Top bar, Stat cards, Data tables, Charts, Modals, Forms, Toast notifications, Dropdown menus, Badges, Avatars, Breadcrumbs

**Marketplace / E-commerce:**
- Product cards, Search bar, Filters, Cart, Checkout form, Reviews, Ratings, Image galleries, Price displays, Category navigation

**Mobile app:**
- Bottom tab bar, Pull-to-refresh, Swipeable cards, Action sheets, Floating action button, List items, Empty states, Onboarding screens

**Landing page:**
- Hero section, Feature grid, Testimonials, Pricing table, CTA buttons, Footer, Navigation, Social proof

Save component inventory to `.planning/design/system/components.md`.

---

## Design System Constraint for Code Generation

**When generating UI code and design tokens already exist:**

Read `.planning/design/system/tokens.md` or `.planning/design-config.md` FIRST. Your code MUST use these tokens. Do NOT use Tailwind defaults, generic colors, or made-up spacing.

Think of it like a jazz musician: the chord progression is set (tokens). Your job is to build beautifully within it. Don't change the key.

---

## Checklist Before Delivering

- [ ] All 3 output formats generated (token doc, Tailwind, CSS variables)
- [ ] Colors have enough contrast (4.5:1 for text)
- [ ] Typography scale is consistent and readable
- [ ] Spacing uses the grid (no arbitrary values)
- [ ] Component inventory matches project type
- [ ] design-config.md updated (if it existed before)
