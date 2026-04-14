# Orchestrero Rebrand Design

Date: 2026-04-14
Status: Approved design
Owner: Codex session

## Goal

Rebrand the visible PrivateClip-branded evolution of Paperclip to `Orchestrero`, set the canonical public URL to `https://www.orchestrero.ai`, remove public links to the upstream Paperclip project, and reuse the Orchestrero logo asset from `/Users/seb/Sites/orchestrero/ui/public/favicon.png` where appropriate.

## Scope

This is a visible-branding and public-link sweep.

In scope:

- User-facing product name changes from `PrivateClip` to `Orchestrero`
- Public-facing links that currently point to `paperclip.ing` or the upstream Paperclip GitHub project
- UI shell branding, favicon usage, manifests, onboarding/invite copy, and other visible app surfaces
- Public docs and repo presentation text that still presents the old brand
- Generated/exported user-facing text that emits old branding into exported artifacts
- New Markdown documentation in `docs/` that can later be ingested/exported by the Orchestrero website

Out of scope:

- Renaming compatibility-critical technical identifiers
- Changing package scopes such as `@paperclipai/*`
- Renaming CLI commands such as `paperclipai`
- Renaming env vars such as `PAPERCLIP_*`
- Renaming local config/data paths such as `~/.paperclip`
- Reworking core architecture or runtime behavior beyond branding/link updates

## Brand Boundary

The rebrand intentionally separates visible product identity from technical compatibility identity.

Visible product identity becomes:

- Product name: `Orchestrero`
- Canonical public URL: `https://www.orchestrero.ai`
- App mark/favicons: based on the cyan circuit/brain icon from `/Users/seb/Sites/orchestrero/ui/public/favicon.png`

Technical compatibility identity remains unchanged for now:

- repo/package naming based on `paperclip`
- package scopes such as `@paperclipai/*`
- CLI usage such as `pnpm paperclipai ...`
- env/config/storage keys such as `PAPERCLIP_*`, `paperclip:*`, and `~/.paperclip`

This keeps existing installs, scripts, configs, and adapter integrations stable while the product is reintroduced publicly as Orchestrero.

## Public Link Policy

After this pass, user-facing surfaces must not direct people to the original Paperclip public properties.

Rules:

- Replace `paperclip.ing` links with `https://www.orchestrero.ai`
- Remove GitHub links where there is no branded Orchestrero destination yet
- Avoid sending users to upstream Paperclip issues, discussions, docs, or repository pages
- Keep internal/local technical instructions intact when they describe compatibility commands or paths

## Asset Strategy

Primary reusable asset:

- `/Users/seb/Sites/orchestrero/ui/public/favicon.png`

Usage plan:

- Use the asset as the source for visible app branding where a logo/mark is needed
- Update favicon-related surfaces to reflect the Orchestrero brand
- Prefer a text-first treatment elsewhere unless a dedicated wordmark exists

This avoids inventing a new visual system inside the rebrand pass while still grounding the app in a distinct Orchestrero mark.

## Change Buckets

### 1. App shell and runtime metadata

Update user-visible app surfaces such as:

- nav/app logo references
- manifest names
- invite/onboarding copy
- docs/help links in the app shell
- favicon and default logo references
- other visible `PrivateClip` labels in React/HTML metadata

### 2. Public docs and repo presentation

Update top-level public docs and presentation surfaces such as:

- `README.md`
- `docs/` as the canonical public website source
- `doc/` only where contributor-facing branding or public URLs would be misleading
- copyright/license presentation where appropriate
- public product framing text that still reads as PrivateClip

### 3. Generated/exported user text

Update generators that emit branded copy into exported artifacts so future exports do not leak the old brand, especially:

- company export README generation
- UI-generated export/help text
- any other generated user-facing Markdown that currently references `PrivateClip` or `paperclip.ing`

### 4. Website-exportable Markdown

Add or refresh useful Markdown pages in `docs/` that can later be exported by the Orchestrero website. Treat `docs/` as the canonical public source and avoid duplicating website-first copy into `doc/` unless contributors need it there too.

Planned doc topics:

- Orchestrero overview / positioning
- brand and public link policy
- logo/asset source note
- migration note explaining what remains technically named `paperclip` for compatibility

## Docs Source of Truth

Public docs source of truth:

- `docs/` is the website-exportable source of truth
- public routing, branding, logo assets, and introductory product copy must be normalized there
- public route slugs under `docs/` must not carry the old `paperclip` brand

Contributor/internal docs boundary:

- `doc/` remains contributor-facing and operational
- update `doc/` selectively when public links or high-visibility branding would otherwise confuse contributors
- do not treat `doc/` as a website export source in this pass

## Asset Pipeline

The Orchestrero mark must become a repo-backed source asset before it is used in production-served surfaces.

Source of truth:

- vendor the reused source mark into the repo under `docs/images/`

Served asset rules:

- app icon consumers keep the current `/favicon*` paths
- docs branding consumers keep repo-served asset paths referenced from `docs/docs.json`
- worktree branding keeps its current override logic and only replaces the default icon in worktree mode

Required produced assets:

- app icons in `ui/public`, including PNG sizes plus `favicon.ico`
- docs logo/favicon assets referenced by the docs site
- no production-served asset may depend on an absolute local path outside the repo

## Approach Options Considered

### Option A: Minimal surface pass

Only update the app shell, favicon, and a few top-level docs.

Pros:

- fastest
- low edit count

Cons:

- old branding would remain in exports, docs, and secondary surfaces
- public users would still encounter upstream references

### Option B: Full visible-brand pass

Update every user-facing brand surface while leaving technical compatibility identifiers alone.

Pros:

- matches requested scope
- removes upstream public references
- minimizes compatibility risk

Cons:

- broad text sweep
- requires judgment to avoid touching technical identifiers

### Option C: Rename everything

Attempt a full repo-wide rename, including package scopes, commands, env vars, and storage paths.

Pros:

- cleanest eventual naming story

Cons:

- high compatibility risk
- far beyond requested scope
- likely to break installs, docs, adapters, and user workflows

Selected approach: Option B.

## Implementation Notes

- Do not use blind global replace for all `paperclip` strings
- Inspect visible/string-emitting surfaces before editing
- Treat tests and internal fixtures carefully; only update them when they assert visible branded output
- Add new docs in Markdown under `docs/` so the website can later ingest/export them
- Preserve compatibility wording where commands or paths would break if renamed

## Verification Strategy

Verification should demonstrate two things:

1. Visible branding now presents `Orchestrero`
2. Public-facing upstream links have been removed or replaced

Checks:

- targeted searches for `PrivateClip`, `paperclip.ing`, and Paperclip GitHub URLs in user-facing surfaces
- favicon/logo sanity check in the app shell
- review of generated/exported README text
- repo verification commands where feasible after edits

If full verification is not feasible in-session, report exactly what was and was not run.

## Risks

- Over-replacing `paperclip` could break compatibility-critical commands or package names
- Under-replacing could leave visible old-brand text in lesser-used flows
- Docs may become inconsistent if `doc/` and `docs/` are updated unevenly
- Some user-facing strings may be embedded in generated content paths and easy to miss without targeted searches

## Acceptance Criteria

- The app presents itself as `Orchestrero` on user-visible brand surfaces
- Public-facing links no longer send users to upstream Paperclip properties
- The reused Orchestrero icon is wired into the app branding where appropriate
- The repo contains useful Markdown documentation in `docs/` for future website export
- Compatibility-critical technical identifiers remain unchanged
