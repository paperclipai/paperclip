---
name: dp-printables
description: Generate, verify, compare and diagnose Exemplar Studio Designed Printable Candidates from governed YAML specs. Use for Dastardly Print binders, planners, trackers, catalogue regeneration, Etsy listing packs, printable QA, or printable Candidate diffs.
---

# DP Printables

Work in `/Users/glad0s/scripts/brand-suite/exemplar-studio`. Use
`/Users/glad0s/.local/bin/exemplar-studio`; do not call Vivliostyle,
ImageMagick, PDF tools, browser print, or legacy generators directly.

## Authority boundary

Agents may run only:

```text
exemplar-studio printable doctor [--json]
exemplar-studio printable list-templates [--json]
exemplar-studio printable generate --spec <spec.yaml> [options] [--json]
exemplar-studio printable generate-catalogue [--out <dir>] [--json]
exemplar-studio printable verify <candidate-dir> [--json]
exemplar-studio printable diff <candidate> <live|approved|path> [--json]
exemplar-studio printable handoff-bundle approved --out <dir> [--json]
```

Agents may not seal or approve a release, accept editorial review, replace live
Etsy files, publish listing assets, set or roll back lifecycle pointers, prune
Candidates, or retire the legacy pipeline. Managed Codex, Paperclip and CI
identities are hard-refused from `seal`, `approve`, `promote-live`, `rollback`,
and `prune`; `replace-live` and `retire-legacy` remain unavailable. Never unset
or spoof identity variables to cross this boundary.

Exit codes are contractual:

- `0`: Candidate generated/reused or verification passed.
- `2`: deterministic content or QA gate failure; revise the source spec.
- `1`: environment, dependency, invocation, or runtime failure; diagnose the tool.

When `--json` is used, branch on `ok`/`status`, `qa.checks`, `checksums`, and
`fingerprint`. Never scrape human progress text.

## Stop-gate

`generate-catalogue` always generates and independently verifies Emergency
Binder first. It must be green before any other SKU regenerates. Never loop the
catalogue by hand or skip the stop-gate.

## Spec contract

A spec must declare:

- `schemaVersion`, `sku`, `title`, `brand`, `sizes`, `variants`, and
  `variantLabels`;
- complete variant-aware `copy` for subtitle, strapline, 3–4 highlights,
  format, how-to introduction, 3–6 how-to steps, and home-print guidance;
- `listing.title` (140 characters maximum), exactly 13 unique tags,
  `listing.description`, and `listing.priceTier`;
- a `license` block unless `license.enabled: false` is an intentional reviewed
  exception; enabled licences append a closing `license-page`;
- `migration` or `provenance` identifying the generator/exporter and source
  revision;
- an ordered `pages` list using only IDs reported by `list-templates`.

Internal variant axes remain `clean` and `sweary`. The clean edition must be
profanity-free. Sharper language in a sweary edition is permitted only in the
subtitle, strapline, or a divider body—never titles, headers, listing metadata,
or filenames.

Every printable brand is locked to its own declared registry accent, a
checksum-pinned foreground logo and original source, RGB, no bleed/crop marks,
and a 13 mm home-print margin. Dastardly Print is `#620306`; AroidAtlas is
`#2F5233`. Any unknown brand, token/registry mismatch, or cross-brand colour
leakage fails closed. Both brands use the identical shared template system;
never fork templates by brand.

## Required flow

1. Run `printable doctor --json`; stop on missing dependencies.
2. Use `list-templates --json` before authoring or changing a spec.
3. Generate the Candidate. Use layout overrides only when the operator requests
   a diagnostic: `density`, `cover-balance`, `type-scale`, and locked `accent`.
4. Require every QA check to pass, including logo-visible, logo-fidelity,
   purity, spelling, buyer-copy overflow, file-size budget, selectable text,
   tagged PDF metadata, listing metadata/images, home-print, determinism, and
   integrity.
5. Run `verify <candidate-dir> --json` independently.
6. Run `diff` against the requested approved/live/path comparison when one is
   available.
7. When an approved pointer exists and the operator requests Etsy staging, run
   `handoff-bundle approved --out <dir>`. Require one folder per SKU, both buyer
   sizes, four exact-Candidate listing tiles and a valid `listing.json`.
8. Hand off the Candidate directory, portal, build fingerprint, checksums, and
   any unavailable comparison pointer to the human operator. Stop there.

Never edit an immutable Candidate. Revise YAML or governed module source and
generate a new fingerprint.

Run `npm run test:isolated` for printable regression or determinism work. Do not
run the complete Exemplar test suite concurrently with `printable generate` or
`generate-catalogue`; the renderer queue is single-flight and intentionally
waits rather than racing a busy machine.
