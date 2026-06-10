# finn-pitch

Standalone AI pitch-deck generator for **Finn**. Answer a short intake → local
Claude CLI writes tailored copy → outputs a self-contained, on-brand HTML deck
with **real** Finn pricing, computed ROI, real product screenshots, and real
customer proof.

No API key (uses your logged-in `claude` CLI). **No dependency on hf-web-v2** —
runs entirely from the committed `data/` + `assets/` snapshot.

## Use

```bash
npm install
npm run ui          # web UI → http://localhost:4321
# or
npm run new         # CLI wizard → generate → render → open
```

In the UI: fill the intake → deck previews inline → swap any screenshot via the
picker → **Export PDF**.

In the deck: arrows/space navigate · `S` speaker notes · `E`/Export PDF · `F` fullscreen.

## What makes decks real (not templated)
- **Pricing** from `data/plans.json` (wallet/credit, real per-credit rates)
- **ROI slide** computed live by `lib/cost-model.mjs` from the client's call
  volume — human cost vs Finn, savings %, connect-rate uplift
- **Proof slide** = a real customer testimonial matched to the client's vertical
- **Title hero** = the real industry photo for the client's vertical
- **Screenshots** = real product UI (`assets/snaps/`), per-slide swappable
- **Capabilities** = real platform stats (<400ms, 46 languages, 99.99%…)
- **Demo** built around a real Finn playbook agent matched to the use case
- **Voice** matched to Finn's actual brand strings + `facts.md`

## Keeping content fresh
Everything in `data/` + `assets/` is a snapshot of hf-web-v2. Refresh it:

```bash
npm run sync -- --src ../hf-web-v2
git commit -am "sync Finn content"
```

See **SOURCES.md** for the full provenance map.

## Layout
```
cli.mjs / server.mjs   CLI + web UI entry points
lib/
  intake.mjs           wizard
  plan.mjs             slide selection rules
  generate.mjs         builds prompt (injects real data) → claude -p → JSON
  render.mjs           slides.json → reveal.js deck
  cost-model.mjs       standalone ROI engine
  finn-data.mjs        loads data/ + matching helpers
  snaps.mjs            slide → product screenshot mapping
  sync.mjs             refresh data/ + assets/ from hf-web-v2
content/slide-plan.json   which slides per clientType/length
theme/finn.css         Finn brand theme
data/                  content snapshot (committed)
assets/                visual snapshot (committed)
dist/                  generated decks (gitignored)
```
