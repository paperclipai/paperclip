# Design Spec — Soloway Travel website (localhost, adapted from paperclip-website)

- **Date:** 2026-06-03
- **Status:** Draft for review
- **Goal:** Clone the `paperclip-website` Astro site, run it on localhost, and adapt its
  brand + content to **Soloway Travel** (the conciergerie / property-management agency).
- **Source repo:** `github.com/paperclipai/paperclip-website` (Astro, static output)
- **Clone target:** `/home/soloway/openclaw-runner/paperclip-website` (sibling of the paperclip checkout)
- **Author:** Oleg (with Claude)

## 1. Purpose & scope

Reuse the `paperclip-website` Astro project as the **public website for Soloway Travel**,
running locally first. This is the "public website" emergent tool from the conciergerie
program (see `2026-06-02-conciergerie-str-paperclip-design.md` → Future Tooling). It is a
brand + content **re-skin**, not a rewrite: keep the Astro structure and design system,
swap branding and copy from "AI agent orchestration" to a conciergerie agency.

**In scope (this spec):**
- Clone the repo; run it on localhost (`astro dev`); confirm a clean static `astro build`.
- Re-brand to Soloway Travel (title/meta/site URL, logo, nav, footer, theme tokens).
- Re-copy the core marketing sections to the conciergerie offering.
- Replace Paperclip-specific feature sections with conciergerie ones.
- Add an **Owners** section + an **owner-portal CTA** that links to a placeholder
  `/owners` page ("request access / coming soon") — the landing spot for the future
  owner invitations. No auth, no data yet.

**Out of scope (deferred, separate specs):**
- **Owners dashboard** (authenticated, data-driven over str-ops CouchDB / Paperclip) — the
  real destination for owner invitations. This is the hard, net-new piece.
- **Hostinger deployment** (static `dist/` → Hostinger, or VPS SSR).
- **Bilingual i18n** (FR/EN).
- Guest booking flow; real owner invitations; CMS.

## 2. Naming & actors (important)

- **Company / brand (dev name): Soloway Travel** — a conciergerie / property-management
  agency for seasonal + long-term rentals. Generic and **multi-owner**.
- **Owners = clients** whose properties Soloway Travel manages. **Deborah is a future
  owner (multi-property), invited later — not the company.** Plan: invite **≥3 owners**
  once the owner area is ready.
- This website serves: (a) the public agency marketing site, and (b) an **owner-portal
  entry point** (a CTA/route) that will later open the owners dashboard.

**Relationship to existing work (not changed here):** the str-ops Paperclip plugin
(shipped, Plan 1) stores owner/property/booking records in CouchDB; the running Paperclip
company instance is currently named "Conciergerie Deborah.net". Realigning that instance
to **Soloway Travel** (with Deborah demoted to owner #1) is a **follow-up**, tracked in §8,
not performed in this spec.

## 3. Source repo facts (verified)

- **Astro static site.** `package.json` deps: `astro` (+ `playwright` dev). Scripts:
  `astro dev` (serves `localhost:4321`), `astro build` (→ static `dist/`), `astro preview`.
  Default deploy script targets **Cloudflare Pages** via `wrangler` (ignored here).
- `astro.config.mjs`: `site: 'https://paperclip.ing'`, Google-font providers (Inter / Inter
  Tight / JetBrains Mono), dev server on port 4321. No SSR adapter → **static output**.
- `src/components/`: `Hero`, `WhatItIs`, `WhatItsNot`, `Features` + `Feature*`
  (`FeatureBYOA`, `FeatureCliphub`, `FeatureCosts`, `FeatureExtensions`,
  `FeatureGoalAlignment`, `FeatureHeartbeats`, `FeatureMultiCompany`, `FeatureOrgChart`,
  `FeatureTickets`), `HowItWorks`, `Governance`, `ProblemsSolved`, `Quickstart`,
  `Terminal`, `Testimonials`, `FAQ`, `CTA`, `Navbar`, `Footer`, `ThemeToggle`, `brand/`.
- `src/layouts/`: `Layout.astro`, `BrandLayout.astro`. `src/pages/`: `index` (composed of
  the components), `brand.astro`, `blog/`. Content collections: `blog`, `comparisons`,
  `releases` (`src/content.config.ts`). A design system (`design-system-changelog.md`).
- `examples/vps-deploy` exists (useful for the later VPS path).

## 4. Architecture / adaptation approach

Keep the Astro project + design system; do a **content + brand re-skin**, swapping
components rather than restructuring. Three layers:

1. **Brand layer** — `astro.config.mjs` `site`, page `<title>`/meta, `Navbar`, `Footer`,
   `brand/` logo assets, and the design-system theme tokens (colors/fonts) → Soloway Travel.
2. **Content layer** — rewrite copy and repurpose components:
   - **Keep + re-copy:** `Hero`, `WhatItIs` (→ "What Soloway Travel does"), `HowItWorks`,
     `FAQ`, `CTA`, `Testimonials` (placeholder quotes), `Navbar`, `Footer`.
   - **Replace** the Paperclip feature set with conciergerie features, reusing the
     `Feature*.astro` pattern (new copy/icons): **Property Management** (seasonal +
     long-term), **Guest Experience**, **Turnover & Maintenance**, **Owner Reporting &
     Payouts**, **Channels & Calendar**. (Map: drop `FeatureBYOA/Cliphub/Extensions/
     MultiCompany/OrgChart/Heartbeats`, repurpose `FeatureCosts`→Owner Reporting,
     `FeatureTickets`→Guest Experience, `FeatureGoalAlignment`→Property Management.)
   - **Remove / park (dev-tool-specific):** `Terminal`, `Quickstart`, `Governance`,
     `WhatItsNot`, `comparisons` + `releases` collections. `blog` → optional "News" (park).
   - **Add:** an **Owners** section on the home page + an **"Owner portal"** nav item /
     CTA → a new static page `/owners` ("Owner area — request access / coming soon"). This
     is the placeholder the future owners-dashboard will replace; the ≥3 owner invitations
     will eventually point here.
3. **Deploy layer** — leave the Cloudflare/`wrangler` scripts unused for now (localhost
   focus); keep `astro build` working so the static `dist/` is Hostinger-ready later.

**Language:** single-language first, **EN default** (source is EN; dev brand is English).
FR / bilingual via Astro i18n is **deferred** — note the real market may be FR; confirm at
content-finalize time (§8).

## 5. Units / boundaries

The Astro site is the deliverable; sub-units are independently editable `.astro` files:
- **theme/brand config** (`astro.config.mjs`, `Navbar`, `Footer`, `brand/`, design tokens)
- **home page sections** (each `Hero`/`Feature*`/`HowItWorks`/`FAQ`/`CTA` = one swappable section)
- **`/owners` placeholder page** (the future dashboard entry point)
- **layout** (`Layout.astro`)

Each section is self-contained (props + copy); changing one doesn't break others.

## 6. Data flow, errors, testing

- **Data flow:** none — fully static. The owner-portal CTA is a **link only** (no data, no
  auth) in this spec; the dashboard (data + auth over str-ops/Paperclip) is deferred.
- **Verification:**
  - `npm run dev` serves `localhost:4321` with no console/build errors.
  - `npm run build` produces `dist/` with no broken internal links or missing assets.
  - Manual visual check of the adapted home page + `/owners`.
  - If the repo ships a Playwright smoke, run it; otherwise a manual pass.

## 7. Build sequence (slices) — for the plan

- **S0** Clone `paperclip-website` → sibling dir; `npm install`; `npm run dev`; confirm the
  baseline (Paperclip) site renders on `localhost:4321` and `npm run build` is clean.
- **S1** Brand layer → Soloway Travel: `astro.config.mjs` `site`, titles/meta, `Navbar`,
  `Footer`, logo (`brand/`), theme tokens.
- **S2** Content layer → rewrite `Hero` + `WhatItIs` + `HowItWorks` + `FAQ` + `CTA` to
  conciergerie copy; replace the `Feature*` set with the 5 conciergerie features.
- **S3** Prune Paperclip-only sections/collections (`Terminal`, `Quickstart`, `Governance`,
  `WhatItsNot`, `comparisons`, `releases`); add the **Owners** section + `/owners`
  placeholder page + owner-portal CTA.
- **S4** Verify (`dev` + `build` clean), capture a screenshot of the adapted site.

## 8. Open items / follow-ups

- **Language:** EN-first now; FR / bilingual (Astro i18n) — confirm and schedule later.
- **Owner-portal route behavior:** placeholder copy + whether it collects "request access"
  emails (static form → mailto / form service) vs pure "coming soon".
- **Company realignment (follow-up):** rename the Paperclip conciergerie company instance
  "Conciergerie Deborah.net" → **Soloway Travel**, and model Deborah + ≥2 others as
  **owners** (records, later dashboard users) — a separate change to the str-ops program.
- **Deferred specs:** owners dashboard (auth + data API; the real owner invitations);
  Hostinger deploy (static `dist/` or VPS SSR using `examples/vps-deploy`); bilingual i18n.

## 9. Review log

- **2026-06-03 — created.** Scope set to localhost run + Soloway Travel re-skin of
  `paperclip-website`; owners dashboard, Hostinger deploy, and i18n explicitly deferred.
  Brand = Soloway Travel (dev name); Deborah reframed as a future multi-property **owner**;
  ≥3 owners to be invited once the owner area exists.
