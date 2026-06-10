# finn-pitch — frozen archive

Verbatim snapshot of the standalone **finn-pitch** repo, vendored into paperclip
so the original repo can be deleted without losing anything.

- **Source HEAD:** `64afcaabebe345b7eeb6d8d1ea54b412eb6549c1`
- **Vendored:** 2026-06-10
- **Why here:** the live pitch-deck generator now runs inside paperclip at
  `server/src/agnb/pitch/` (an *adapted* copy — bucket-based assets, returns HTML
  instead of writing files, dev-only `claude` shell-out). This archive keeps the
  parts that were **not** ported: the standalone harness and provenance.

## This is NOT built or imported by paperclip
`vendor/` is outside every tsconfig/vite glob (`server/tsconfig.json` → `include: ["src"]`).
Nothing here runs in the paperclip server. It is a cold archive only.

## What's preserved that the live copy dropped
- `server.mjs` — standalone Express preview UI (replaced by `/agnb/pitch/*` routes)
- `cli.mjs`, `lib/intake.mjs` — terminal intake (replaced by the web form)
- `lib/inline.mjs` — self-contained HTML export (shells an external binary)
- `lib/pdf.mjs` — 16:9 PDF export (shells a headless-browser binary)
- `lib/logo.mjs` — client-logo scraping (disabled in the live copy, v1)
- `lib/investor.mjs` + `data/finn-company.json` — the investor-deck variant (never ported)
- `lib/standalone.mjs`, `lib/sync.mjs` — local-server + content-sync from `hf-web-v2`
- `assets/` — the 11 MB of original binary assets. The live copy serves these from
  `gs://agnb-pitch-assets` via `snapshot/asset-manifest.json`; this dir is the
  source-of-truth originals.
- `finn-pitch.full-history.bundle` — complete git history. Restore the whole repo with:
  `git clone finn-pitch.full-history.bundle finn-pitch`
- `gitignore.archived.txt` — the original `.gitignore` (renamed so paperclip tracks the full snapshot).

## To run it standalone again
```
cp -r vendor/finn-pitch /tmp/finn-pitch && cd /tmp/finn-pitch
mv gitignore.archived.txt .gitignore
npm install && npm run ui   # http://localhost:4321
```
