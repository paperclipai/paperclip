# Soloway Travel Website — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the cloned `paperclip-website` Astro site on localhost and re-skin it (brand + content) into the **Soloway Travel** conciergerie / property-management site, with a placeholder Owners portal entry point.

**Architecture:** Keep the Astro project structure + design system; swap branding (tokens, wordmark, meta, nav, footer) and replace marketing copy/sections (AI-agent orchestration → conciergerie services). Static output (`astro build` → `dist/`) — no backend. The owner-portal CTA is a link to a static `/owners` placeholder; the real owners dashboard (auth + data) is a separate, deferred project.

**Tech Stack:** Astro (static), CSS custom-property design tokens, Google fonts (Inter / Inter Tight / JetBrains Mono) via `astro:assets`. Node + npm. Verification = clean `astro build` + local visual check (no unit-test framework in this repo for content).

**Spec:** `docs/superpowers/specs/2026-06-03-soloway-travel-website-design.md`

**Working directory for ALL tasks:** `/home/soloway/openclaw-runner/paperclip-website` (the cloned website repo — a SEPARATE git repo from the paperclip checkout). Commit there.

---

## Brand reference (use verbatim across tasks)

- **Name / wordmark:** `Soloway Travel`
- **Tagline / meta description:** `Soloway Travel — full-service conciergerie and property management for seasonal and long-term rentals: guests, turnovers, pricing, and clear owner reporting.`
- **Title:** `Soloway Travel — Conciergerie & property management`
- **Site URL (dev placeholder):** `https://soloway.travel`
- **Brand accent token:** `--brand: #C2603F;` (terracotta) + `--brand-ink: #FFFFFF;`
- **Language:** `en` (FR/bilingual deferred).
- **Owner-portal route:** `/owners` (static placeholder this plan; future dashboard later).
- **Theme localStorage key:** rename `paperclip-theme` → `soloway-theme` (Layout + ThemeToggle).

## Conciergerie content reference (use verbatim)

**Hero** — headline: `Your property, expertly hosted.` · lede: `Soloway Travel manages your seasonal and long-term rentals end-to-end — guest care, turnovers, pricing, and transparent owner reporting.` · primary CTA: `Owner portal` → `/owners` · secondary CTA: `How it works` → `#how-it-works`.

**HowItWorks** — 3 steps:
1. `Onboard your property` — `Tell us about your place. We set up listings, calendars, and house details.`
2. `We host and manage` — `Guest messaging, check-in, cleaning turnovers, and maintenance — handled.`
3. `You get paid, with clarity` — `Monthly statements: revenue, fees, payouts, and occupancy — no guesswork.`

**Five feature sections** (heading + body):
1. `Property Management` — `Seasonal and long-term rentals managed end-to-end, with one point of contact.`
2. `Guest Experience` — `Fast multilingual guest messaging, smooth check-in, and local recommendations.`
3. `Turnover & Maintenance` — `Cleaning scheduled around every checkout; issues fixed before the next guest.`
4. `Pricing & Channels` — `Dynamic pricing and synced calendars across booking channels — no double bookings.`
5. `Owner Reporting & Payouts` — `Clear monthly statements: revenue, fees, commission, and payouts per property.`

**FAQ** (Q/A):
- `What does Soloway Travel manage?` — `Short-term (seasonal) and long-term rentals: listings, guests, turnovers, pricing, and owner reporting.`
- `How are owners paid?` — `You receive a monthly statement and payout per property — revenue minus fees and commission, itemized.`
- `Which areas do you cover?` — `We focus on the South of France; contact us for your location.`
- `How do I get started?` — `Request access to the owner portal and we'll onboard your property.`

**CTA** (final banner) — heading: `List your property with Soloway Travel.` · button: `Request owner access` → `/owners`.

**Footer** — `© 2026 Soloway Travel` · links: `How it works` (`#how-it-works`), `Owner portal` (`/owners`). Remove GitHub/Docs/X/Discord.

**/owners page** — heading `Owner portal` · body `The Soloway Travel owner dashboard — your properties, bookings, occupancy, and monthly statements — is coming soon. Access is by invitation while we onboard our first owners.` · CTA `Request access` → `mailto:owners@soloway.travel`.

---

## File map

```
paperclip-website/                      (cloned; separate git repo)
├── astro.config.mjs                    # MODIFY: site URL
├── src/styles/tokens.css               # MODIFY: add --brand tokens
├── src/layouts/Layout.astro            # MODIFY: title/desc/ogImage default, site fallback, theme key
├── src/components/Navbar.astro         # REWRITE: wordmark text, links, Owner-portal CTA, drop star script
├── src/components/Footer.astro         # MODIFY: brand + links
├── src/components/Hero.astro           # MODIFY: headline/lede/CTAs (keep bg + styles)
├── src/components/HowItWorks.astro     # MODIFY: 3 conciergerie steps  (id="how-it-works")
├── src/components/WhatItIs.astro       # MODIFY: "What Soloway Travel does" copy
├── src/components/FAQ.astro            # MODIFY: conciergerie Q/A
├── src/components/CTA.astro            # MODIFY: "List your property" + /owners
├── src/components/Features.astro       # MODIFY: section heading/intro
├── src/components/FeatureOrgChart.astro etc. # MODIFY: repurpose 5 → conciergerie features (copy swap)
├── src/components/Owners.astro         # CREATE: home "Owners" section
├── src/pages/index.astro               # REWRITE: conciergerie composition
├── src/pages/owners.astro              # CREATE: owner-portal placeholder page
└── (prune) Terminal/Quickstart/Governance/WhatItsNot + content/comparisons,releases
```

> Theme/brand files were read while planning; anchors below are exact as of clone HEAD. If a file differs, open it and apply the described change to the matching element.

---

## Task S0: Clone, install, run baseline

**Files:** none (setup + verification)

- [ ] **Step 1: Clone (if not already present)**

Run:
```bash
cd /home/soloway/openclaw-runner
[ -d paperclip-website/.git ] || gh repo clone paperclipai/paperclip-website paperclip-website
cd paperclip-website
```
Expected: repo present at `/home/soloway/openclaw-runner/paperclip-website`.

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes; `node_modules/` present; `astro` available.

- [ ] **Step 3: Build baseline (confirm it compiles before changes)**

Run: `npm run build`
Expected: `astro build` completes, writes `dist/` with no errors.

- [ ] **Step 4: Run dev server (background) + confirm it serves**

Run:
```bash
(npm run dev >/tmp/soloway-dev.log 2>&1 &) ; sleep 4 ; curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:4321/
```
Expected: `200`. (Astro dev on `localhost:4321`.) Leave it running or stop with `pkill -f "astro dev"`.

- [ ] **Step 5: Baseline commit point (no code change yet)**

Confirm clean tree: `git status --short` → empty. (No commit needed; baseline is the clone HEAD.)

---

## Task S1: Brand layer → Soloway Travel

**Files:**
- Modify: `astro.config.mjs`
- Modify: `src/styles/tokens.css`
- Modify: `src/layouts/Layout.astro`
- Modify: `src/components/Navbar.astro`
- Modify: `src/components/Footer.astro`

- [ ] **Step 1: `astro.config.mjs` — site URL**

Replace:
```js
  site: 'https://paperclip.ing',
```
with:
```js
  site: 'https://soloway.travel',
```

- [ ] **Step 2: `src/styles/tokens.css` — add brand accent**

After the `--ink: #0A0A0A;` line (end of the literal brand block), add:
```css
  --brand:     #C2603F;   /* Soloway Travel terracotta */
  --brand-ink: #FFFFFF;
```

- [ ] **Step 3: `src/layouts/Layout.astro` — meta defaults, site fallback, theme key**

Replace the props defaults block:
```js
const {
  title = 'Paperclip – The app people use to manage AI agents for work',
  description = 'Manage a team of AI agents to run your business. Org charts, budgets, governance, and goals — all in one deployment.',
  ogImage = '/og-v3.jpg',
} = Astro.props;
```
with:
```js
const {
  title = 'Soloway Travel — Conciergerie & property management',
  description = 'Soloway Travel — full-service conciergerie and property management for seasonal and long-term rentals: guests, turnovers, pricing, and clear owner reporting.',
  ogImage = '/og-v3.jpg',
} = Astro.props;
```
Replace `Astro.site ?? 'https://paperclip.ing'` with `Astro.site ?? 'https://soloway.travel'`.
Replace the FOUC script's theme key `'paperclip-theme'` with `'soloway-theme'`:
```js
var t = localStorage.getItem('soloway-theme') || 'dark';
```

- [ ] **Step 4: `src/components/ThemeToggle.astro` — match theme key**

Run: `grep -n "paperclip-theme" src/components/ThemeToggle.astro`
Replace every `'paperclip-theme'` occurrence with `'soloway-theme'` so the toggle and the FOUC script agree. (If none found, skip.)

- [ ] **Step 5: `src/components/Navbar.astro` — rewrite brand region**

Replace the `<nav>…</nav>` markup AND remove the GitHub-star `<script>` block. Use this `<nav>` (keep the existing `<style>` block unchanged):
```astro
<nav class="navbar">
  <div class="navbar-inner">
    <div class="navbar-left">
      <a href="/#how-it-works" class="navbar-link">How it works</a>
      <a href="/#features" class="navbar-link">Services</a>
      <a href="/#faq" class="navbar-link">FAQ</a>
    </div>
    <a href="/" class="navbar-logo" aria-label="Soloway Travel">
      <span class="navbar-wordmark-text">Soloway&nbsp;Travel</span>
    </a>
    <div class="navbar-right">
      <a href="/owners" class="navbar-cta">Owner portal</a>
    </div>
  </div>
</nav>
```
Then delete the entire `<script is:inline> … REPO = 'paperclipai/paperclip' … </script>` block (the star-count fetcher). In the `<style>` block, add a rule for the text wordmark:
```css
  .navbar-wordmark-text {
    font-family: var(--font-serif);
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: -0.02em;
    color: var(--ink-t);
    white-space: nowrap;
  }
```

- [ ] **Step 6: `src/components/Footer.astro` — brand + links**

Run: `sed -n '1,80p' src/components/Footer.astro` to see its structure. Replace the brand name/wordmark with `Soloway Travel`, set the copyright line to `© 2026 Soloway Travel`, and reduce the link list to: `How it works` → `/#how-it-works`, `Owner portal` → `/owners`. Remove GitHub / Docs / X / Discord / blog links and any Paperclip wordmark SVG (use the text `Soloway Travel`).

- [ ] **Step 7: Build + visual check**

Run: `npm run build`
Expected: clean build. Then `npm run dev` and confirm the navbar shows "Soloway Travel" + "Owner portal", title in the tab is the Soloway title, no console error about the missing star script.

- [ ] **Step 8: Commit**

```bash
git add astro.config.mjs src/styles/tokens.css src/layouts/Layout.astro src/components/ThemeToggle.astro src/components/Navbar.astro src/components/Footer.astro
git commit -m "feat(site): brand layer -> Soloway Travel (tokens, meta, navbar, footer)"
```

---

## Task S2: Content layer → conciergerie copy + features

**Files:**
- Modify: `src/components/Hero.astro`
- Modify: `src/components/HowItWorks.astro`
- Modify: `src/components/WhatItIs.astro`
- Modify: `src/components/Features.astro`
- Modify: the 5 feature components used on the home page (see Step 5)

- [ ] **Step 1: `src/components/Hero.astro` — headline / lede / CTAs**

Replace the `.hero-inner` content block (the `<h1>`, `<p>`, and `.hero-actions`) — keep all CSS, scripts, and the `.hero-bg` SVG block unchanged:
```astro
  <div class="container hero-inner">
    <h1 class="hero-headline">
      Your property,<br />expertly hosted.
    </h1>
    <p class="hero-lede">
      Soloway Travel manages your seasonal and long-term rentals<br />
      end-to-end — guests, turnovers, pricing, and clear owner reporting.
    </p>
    <div class="hero-actions">
      <a href="/owners" class="hero-btn-primary">Owner portal</a>
      <a href="#how-it-works" class="hero-btn-secondary">
        How it works
      </a>
    </div>
  </div>
```

- [ ] **Step 2: `src/components/HowItWorks.astro` — 3 conciergerie steps + section id**

Open the file. Ensure the section element has `id="how-it-works"`. Replace its three step headings/bodies with the **HowItWorks** content from the reference above (Onboard your property / We host and manage / You get paid, with clarity). Keep the component's existing layout/markup; swap only the text nodes.

- [ ] **Step 3: `src/components/WhatItIs.astro` — agency description**

Replace its heading + paragraph with:
- heading: `What Soloway Travel does`
- body: `We are your single point of contact for hosting and managing rental properties — from guest messaging and check-in to cleaning, maintenance, pricing, and transparent monthly owner statements.`

- [ ] **Step 4: `src/components/Features.astro` — section heading/intro + id**

Ensure the section has `id="features"`. Replace its heading/intro with heading `Everything your property needs` and intro `One team for guests, turnovers, pricing, and owner reporting.`

- [ ] **Step 5: Repurpose 5 feature components (copy swap)**

The home page (rebuilt in S3) will render these five components with conciergerie copy. For EACH file below, open it and replace its heading + body text (keep the component's markup/layout/icon container) with the mapped content from the **Five feature sections** reference:

| File | New heading | New body |
|---|---|---|
| `src/components/FeatureOrgChart.astro` | Property Management | Seasonal and long-term rentals managed end-to-end, with one point of contact. |
| `src/components/FeatureTickets.astro` | Guest Experience | Fast multilingual guest messaging, smooth check-in, and local recommendations. |
| `src/components/FeatureHeartbeats.astro` | Turnover & Maintenance | Cleaning scheduled around every checkout; issues fixed before the next guest. |
| `src/components/FeatureGoalAlignment.astro` | Pricing & Channels | Dynamic pricing and synced calendars across booking channels — no double bookings. |
| `src/components/FeatureCosts.astro` | Owner Reporting & Payouts | Clear monthly statements: revenue, fees, commission, and payouts per property. |

For each: replace the primary heading text and the descriptive paragraph(s). Remove any Paperclip-specific sub-copy, code samples, terminal snippets, or links inside these components. Leave styling and structural wrappers intact.

- [ ] **Step 6: Build + visual check**

Run: `npm run build` → clean. `npm run dev` → hero, how-it-works, features all show conciergerie copy; anchor links (`#how-it-works`, `#features`) scroll correctly.

- [ ] **Step 7: Commit**

```bash
git add src/components/Hero.astro src/components/HowItWorks.astro src/components/WhatItIs.astro src/components/Features.astro src/components/FeatureOrgChart.astro src/components/FeatureTickets.astro src/components/FeatureHeartbeats.astro src/components/FeatureGoalAlignment.astro src/components/FeatureCosts.astro
git commit -m "feat(site): conciergerie content — hero, how-it-works, 5 service features"
```

---

## Task S3: Prune Paperclip-only sections + Owners section + /owners page + recompose

**Files:**
- Modify: `src/components/FAQ.astro`
- Modify: `src/components/CTA.astro`
- Create: `src/components/Owners.astro`
- Create: `src/pages/owners.astro`
- Modify: `src/pages/index.astro`
- Delete (optional): `src/components/Terminal.astro`, `Quickstart.astro`, `Governance.astro`, `WhatItsNot.astro`, `WhySpecial.astro`, `ProblemsSolved.astro`
- Modify: `src/content.config.ts` + remove `src/content/comparisons`, `src/content/releases` (optional)

- [ ] **Step 1: `src/components/FAQ.astro` — conciergerie Q/A + id**

Ensure the section has `id="faq"`. Replace the existing Q/A items with the four **FAQ** items from the reference (What does Soloway Travel manage / How are owners paid / Which areas / How do I get started). Keep the accordion markup; swap text.

- [ ] **Step 2: `src/components/CTA.astro` — final banner**

Replace its heading with `List your property with Soloway Travel.` and its button with a link `Request owner access` → `/owners`. Remove any `npx`/install command or GitHub link.

- [ ] **Step 3: Create `src/components/Owners.astro` (home "Owners" section)**

```astro
---
---
<section id="owners" class="owners container">
  <div class="owners-inner">
    <h2 class="owners-title">For property owners</h2>
    <p class="owners-lede">
      Hand us the keys. We handle guests, turnovers, pricing, and reporting —
      you get a clear monthly statement and payout per property.
    </p>
    <a href="/owners" class="owners-cta">Owner portal</a>
  </div>
</section>

<style>
  .owners {
    padding: clamp(3rem, 7vw, 6rem) var(--space-md);
  }
  .owners-inner {
    max-width: 720px;
    margin: 0 auto;
    text-align: center;
  }
  .owners-title {
    font-family: var(--font-serif);
    font-size: clamp(1.75rem, 4vw, 2.5rem);
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--ink-t);
    margin-bottom: 1rem;
  }
  .owners-lede {
    color: var(--mono);
    font-size: 1.05rem;
    line-height: 1.6;
    margin-bottom: 2rem;
  }
  .owners-cta {
    display: inline-block;
    font-weight: 500;
    padding: 0.8rem 2rem;
    border-radius: var(--r-pill);
    background: var(--brand);
    color: var(--brand-ink);
    border: 1px solid var(--brand);
    transition: opacity var(--t-short) var(--ease-enter);
  }
  .owners-cta:hover { opacity: 0.88; }
</style>
```

- [ ] **Step 4: Create `src/pages/owners.astro` (owner-portal placeholder)**

```astro
---
import Layout from '../layouts/Layout.astro';
import Navbar from '../components/Navbar.astro';
import Footer from '../components/Footer.astro';
---
<Layout title="Owner portal — Soloway Travel" description="The Soloway Travel owner dashboard is coming soon. Access is by invitation while we onboard our first owners.">
  <Navbar />
  <main class="owner-portal container">
    <section class="owner-portal-inner">
      <h1 class="owner-portal-title">Owner portal</h1>
      <p class="owner-portal-body">
        The Soloway Travel owner dashboard — your properties, bookings, occupancy,
        and monthly statements — is coming soon. Access is by invitation while we
        onboard our first owners.
      </p>
      <a href="mailto:owners@soloway.travel" class="owner-portal-cta">Request access</a>
    </section>
  </main>
  <Footer />
</Layout>

<style>
  .owner-portal { padding: clamp(4rem, 10vw, 8rem) var(--space-md); }
  .owner-portal-inner { max-width: 640px; margin: 0 auto; text-align: center; }
  .owner-portal-title {
    font-family: var(--font-serif);
    font-size: clamp(2rem, 6vw, 3rem);
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--ink-t);
    margin-bottom: 1.25rem;
  }
  .owner-portal-body { color: var(--mono); font-size: 1.05rem; line-height: 1.65; margin-bottom: 2rem; }
  .owner-portal-cta {
    display: inline-block; font-weight: 500; padding: 0.8rem 2rem;
    border-radius: var(--r-pill); background: var(--brand); color: var(--brand-ink);
    border: 1px solid var(--brand); transition: opacity var(--t-short) var(--ease-enter);
  }
  .owner-portal-cta:hover { opacity: 0.88; }
</style>
```

- [ ] **Step 5: Rewrite `src/pages/index.astro` (conciergerie composition)**

Replace the whole file with:
```astro
---
import Layout from '../layouts/Layout.astro';
import Navbar from '../components/Navbar.astro';
import Hero from '../components/Hero.astro';
import WhatItIs from '../components/WhatItIs.astro';
import HowItWorks from '../components/HowItWorks.astro';
import Features from '../components/Features.astro';
import FeatureOrgChart from '../components/FeatureOrgChart.astro';
import FeatureTickets from '../components/FeatureTickets.astro';
import FeatureHeartbeats from '../components/FeatureHeartbeats.astro';
import FeatureGoalAlignment from '../components/FeatureGoalAlignment.astro';
import FeatureCosts from '../components/FeatureCosts.astro';
import Owners from '../components/Owners.astro';
import FAQ from '../components/FAQ.astro';
import CTA from '../components/CTA.astro';
import Footer from '../components/Footer.astro';
---

<Layout>
  <Navbar />
  <main>
    <Hero />
    <WhatItIs />
    <HowItWorks />
    <Features />
    <FeatureOrgChart />
    <FeatureTickets />
    <FeatureHeartbeats />
    <FeatureGoalAlignment />
    <FeatureCosts />
    <Owners />
    <FAQ />
    <CTA />
  </main>
  <Footer />
</Layout>
```
(This drops `Quickstart`, `Testimonials`, `Governance`, `FeatureExtensions` from the home composition. Leaving those component files unused is fine; deletion is Step 6.)

- [ ] **Step 6: (Optional) Delete unused Paperclip-only components + content**

Run:
```bash
git rm src/components/Terminal.astro src/components/Quickstart.astro src/components/Governance.astro src/components/WhatItsNot.astro src/components/WhySpecial.astro src/components/ProblemsSolved.astro src/components/FeatureExtensions.astro src/components/FeatureBYOA.astro src/components/FeatureCliphub.astro src/components/FeatureMultiCompany.astro 2>/dev/null || true
```
Then ensure nothing still imports them: `grep -rn "Terminal\|Quickstart\|Governance\|WhatItsNot\|WhySpecial\|ProblemsSolved\|FeatureExtensions\|FeatureBYOA\|FeatureCliphub\|FeatureMultiCompany" src/pages src/components | grep import` → must be empty. (If `blog`/`comparisons`/`releases` pages import removed pieces, leave those collections for now or remove their pages too.)

- [ ] **Step 7: Build + visual check**

Run: `npm run build`
Expected: clean build, no "cannot find module" from removed components. Then `npm run dev`: home shows Hero → WhatItIs → HowItWorks → 5 features → Owners → FAQ → CTA → Footer; `/owners` renders the placeholder; navbar "Owner portal" → `/owners`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(site): FAQ/CTA copy, Owners section + /owners page, recompose home, prune paperclip-only sections"
```

---

## Task S4: Final verification

**Files:** none

- [ ] **Step 1: Clean build**

Run: `npm run build`
Expected: exits 0, `dist/` written, no warnings about missing imports/assets.

- [ ] **Step 2: Link/content sanity**

Run: `grep -rin "paperclip" dist/index.html dist/owners/index.html | head`
Expected: no user-visible "Paperclip" brand strings in the rendered home/owners pages (decorative SVG filenames in assets are acceptable; brand copy must be Soloway Travel). Fix any leftover copy found.

- [ ] **Step 3: Serve + screenshot**

Run: `npm run dev` (background), then capture `http://localhost:4321/` and `http://localhost:4321/owners` (browser screenshot or `curl` the HTML). Confirm visually: Soloway Travel branding, conciergerie copy, Owner portal CTA, terracotta accent on owner CTAs.

- [ ] **Step 4: Stop dev server**

Run: `pkill -f "astro dev" || true`

- [ ] **Step 5: Final commit (if any fixups)**

```bash
git add -A && git commit -m "chore(site): final verification fixups (Soloway Travel re-skin)" || echo "nothing to commit"
```

---

## Deferred (NOT in this plan — separate specs)

- **Owners dashboard** — authenticated, data-driven (str-ops CouchDB / Paperclip); the real destination for owner invitations (Deborah + ≥2 others). The `/owners` page is the placeholder it will replace.
- **Hostinger deployment** — `astro build` → upload/git-deploy `dist/` (static), or VPS SSR via the repo's `examples/vps-deploy`.
- **Bilingual FR/EN** (Astro i18n).
- **Realign the Paperclip company** instance "Conciergerie Deborah.net" → "Soloway Travel" + Deborah-as-owner.

## Self-review (author)

- **Spec coverage:** clone+localhost (S0) ✓; brand layer S1 (tokens/meta/navbar/footer + site URL + theme key) ✓; content layer S2 (hero/howitworks/whatitis/5 features) ✓; prune + Owners section + `/owners` + recompose S3 ✓; verify S4 ✓; EN-first ✓; deploy/dashboard/i18n deferred ✓.
- **Placeholders:** none — exact brand values, exact copy, full code for new files (`Owners.astro`, `owners.astro`, navbar nav, index composition). Component copy-swaps give exact target text per file (table), not "similar to".
- **Consistency:** theme key `soloway-theme` changed in BOTH Layout + ThemeToggle (S1.3/S1.4); section ids `#how-it-works`/`#features`/`#faq` set where nav/hero link to them; `/owners` referenced by Navbar, Hero, Owners section, CTA — all point to the page created in S3.4; `--brand` token (S1.2) used by Owners + owners-page + CTAs.
