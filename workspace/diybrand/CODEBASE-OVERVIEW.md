# DIYBrand Codebase Overview

## What is DIYBrand?

An AI-powered brand identity builder. Users answer a questionnaire, then AI generates a complete brand kit (logo, color palette, typography, guidelines). One-time purchase ($19 Basic / $49 Premium), no subscriptions. Currently in early access (free).

**Live URL:** https://diybrand.app

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, React 19) |
| Language | TypeScript 5.9 |
| Styling | Tailwind CSS 4 + CSS custom properties |
| Database | PostgreSQL via Drizzle ORM |
| Payments | Stripe (Checkout Sessions + Webhooks) |
| AI / Logo Gen | Google Gemini 2.0 Flash (`@google/generative-ai`) |
| Animations | Framer Motion, tsparticles |
| Export | JSZip (brand kit ZIP generation) |
| Deployment | Vercel |

## Project Structure

```
diybrand/
├── src/
│   ├── app/
│   │   ├── page.tsx                  # Landing page (hero, features, pricing, testimonials)
│   │   ├── layout.tsx                # Root layout (fonts: Inter, Space Grotesk, JetBrains Mono; JSON-LD SEO)
│   │   ├── globals.css               # Design tokens, glassmorphism, neon effects, aurora animations
│   │   ├── questionnaire/page.tsx    # Questionnaire wizard page
│   │   ├── success/page.tsx          # Post-payment download page
│   │   ├── opengraph-image.tsx       # Dynamic OG image
│   │   ├── robots.ts                 # Robots.txt config
│   │   ├── sitemap.ts                # Sitemap config
│   │   └── api/
│   │       ├── waitlist/route.ts           # POST: add email to waitlist
│   │       ├── questionnaire/route.ts      # GET/POST/PUT: CRUD questionnaire
│   │       ├── questionnaire/[id]/route.ts # GET: fetch questionnaire by ID
│   │       ├── generate/palette/route.ts   # POST: generate 4 color palettes (algorithmic)
│   │       ├── generate/typography/route.ts# POST: generate 3 font pairings (algorithmic)
│   │       ├── generate/logo/route.ts      # POST: generate 4 logos (Gemini AI)
│   │       ├── palette/select/route.ts     # POST: select a palette
│   │       ├── typography/select/route.ts  # POST: select a typography pair
│   │       ├── logo/select/route.ts        # POST: select a logo
│   │       ├── logos/[id]/image/route.ts   # GET: serve logo image (file or legacy base64)
│   │       ├── checkout/route.ts           # POST: create Stripe checkout session
│   │       ├── checkout/verify/route.ts    # GET: verify payment status
│   │       ├── webhooks/stripe/route.ts    # POST: Stripe webhook handler
│   │       └── export/brand-kit/[id]/route.ts # GET: download brand kit ZIP
│   ├── components/
│   │   ├── BrandWizard.tsx           # Multi-step wizard orchestrator (9 steps)
│   │   ├── BrandMockup.tsx           # Animated brand preview for landing page
│   │   ├── HeroHeadline.tsx          # Animated hero text (Framer Motion)
│   │   ├── LiveDemo.tsx              # Interactive try-it-now demo on landing page
│   │   ├── ParticleField.tsx         # Floating particle background (tsparticles)
│   │   ├── CursorSpotlight.tsx       # Mouse-following glow effect (desktop only)
│   │   ├── ScrollReveal.tsx          # Scroll-triggered fade-in wrapper
│   │   ├── StepProgress.tsx          # Step progress bar with labels
│   │   ├── WaitlistForm.tsx          # Email signup form
│   │   ├── ErrorBoundary.tsx         # React error boundary
│   │   └── steps/
│   │       ├── StepBusinessBasics.tsx    # Step 1: name, industry, description
│   │       ├── StepTargetAudience.tsx    # Step 2: audience description
│   │       ├── StepBrandPersonality.tsx  # Step 3: select 3-5 personality adjectives
│   │       ├── StepInspiration.tsx       # Step 4: competitors, visual preferences
│   │       ├── StepReview.tsx            # Step 5: summary of inputs
│   │       ├── StepPalette.tsx           # Step 6: generate & select color palette
│   │       ├── StepTypography.tsx        # Step 7: generate & select font pairing
│   │       ├── StepLogo.tsx              # Step 8: generate & select logo
│   │       └── StepExport.tsx            # Step 9: choose tier & checkout
│   ├── lib/
│   │   ├── palette.ts                # Algorithmic palette generation (industry hue + personality modifiers, WCAG AA)
│   │   ├── typography.ts             # Font pairing engine (20+ Google Fonts catalog, personality matching)
│   │   ├── logo.ts                   # Gemini 2.0 Flash logo generation (4 concepts per request)
│   │   ├── storage.ts                # File-based logo storage (data/logos/ directory)
│   │   └── stripe.ts                 # Stripe client singleton + tier pricing config
│   └── db/
│       ├── index.ts                  # Drizzle PostgreSQL connection
│       └── schema.ts                 # Database schema (6 tables)
├── drizzle/                          # SQL migrations (5 migrations)
├── drizzle.config.ts                 # Drizzle Kit config
├── agents/                           # Paperclip agent configs (ceo, viktor, nova, quinn, max)
├── package.json
├── tsconfig.json
├── next.config.ts
└── postcss.config.mjs
```

## Database Schema (6 tables)

| Table | Purpose |
|-------|---------|
| `waitlist` | Email signups (id, email unique, createdAt) |
| `brand_questionnaire` | Core questionnaire data + progress tracking (currentStep, completedAt) |
| `brand_palette` | Generated color palettes (JSONB colors with role/hex/HSL, selected flag) |
| `brand_typography` | Font pairs (heading + body family/weight/category, selected flag) |
| `brand_logos` | Logo records (imagePath file storage + legacy imageData base64, selected flag) |
| `orders` | Stripe orders (email, stripeSessionId, tier basic/premium, paidAt) |

All tables use UUID primary keys. Palette, typography, logos, and orders reference `brand_questionnaire` via foreign key.

## User Flow

1. **Landing page** → "Build My Brand" CTA or waitlist signup
2. **Questionnaire** (Steps 1-5): Business basics → Target audience → Brand personality (3-5 adjectives) → Inspiration → Review
3. **Generation** (Steps 6-8): Color palette (algorithmic, 4 options) → Typography (algorithmic, 3 options) → Logo (Gemini AI, 4 concepts)
4. **Export** (Step 9): Choose tier ($19 Basic / $49 Premium) → Stripe checkout
5. **Success page**: Verify payment → Download brand kit ZIP

Session recovery: questionnaire ID stored in localStorage allows resuming incomplete sessions.

## Brand Kit ZIP Contents

- `logos/` — Selected logo images
- `colors/` — palette.json, palette.css (CSS variables), palette.html (visual swatch)
- `typography/` — typography.json, typography.css, typography.html (specimen guide)
- `README.md` — Summary and quick start guide

## Design System

Dark neon aesthetic with glassmorphism:

- **Background**: `--bg-void: #0a0a0f`, `--bg-surface: #12121a`
- **Primary**: `--primary: #8b5cf6` (purple)
- **Accents**: pink `#f72585`, cyan `#00f5ff`, lime `#a8ff3e`
- **Glass**: Semi-transparent backgrounds with backdrop blur
- **Effects**: Aurora gradient animations, neon glow hovers, cursor spotlight, particle field
- **Fonts**: Inter (body), Space Grotesk (headings), JetBrains Mono (code/labels)

## Environment Variables

```
DATABASE_URL=postgresql://...          # PostgreSQL connection
NEXT_PUBLIC_APP_URL=http://localhost:3000
STRIPE_SECRET_KEY=...                  # Stripe API key (not in .env.example but required)
STRIPE_WEBHOOK_SECRET=...              # Stripe webhook signing secret
GOOGLE_GENERATIVE_AI_API_KEY=...       # Gemini API key (for logo generation)
```

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| next | 16.1.7 | Framework |
| react | 19.2.4 | UI library |
| drizzle-orm | 0.45.1 | Database ORM |
| postgres | 3.4.8 | PostgreSQL driver |
| stripe | 20.4.1 | Payment processing |
| @google/generative-ai | 0.24.1 | Gemini API for logo generation |
| framer-motion | 12.38.0 | Animations |
| @tsparticles/react | 3.0.0 | Particle effects |
| jszip | 3.10.1 | ZIP file generation |
| tailwindcss | 4.2.1 | Utility-first CSS |

## Scripts

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run start        # Start production server
npm run lint         # ESLint
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run migrations
npm run db:push      # Push schema to DB
npm run db:studio    # Open Drizzle Studio
```

## Architecture Notes

- **Palette and typography generation are algorithmic** (no AI cost) — they use industry-to-hue mappings and personality-based HSL modifiers with a curated font catalog.
- **Logo generation uses Gemini 2.0 Flash** with image generation capability. Sequential generation with 30s timeout per concept.
- **Logo storage migrated from base64-in-DB to file-based storage** (`data/logos/` directory). Legacy base64 fallback still supported for older records.
- **Payment flow**: Stripe Checkout Sessions → webhook confirms payment → order record created. Verify endpoint provides fallback if webhook is delayed.
- **No authentication system** — questionnaires are anonymous, identified only by UUID. Session recovery via localStorage.
