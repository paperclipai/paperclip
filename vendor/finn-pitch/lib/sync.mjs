#!/usr/bin/env node
// Sync content + assets from the hf-web-v2 source repo into finn-pitch's
// committed snapshot (data/ + assets/). Run when Finn's site content changes.
//
//   npm run sync -- --src ../hf-web-v2
//
// Strategy: esbuild bundles each pure-data TS module (resolving @/ alias,
// stripping types, externalizing next/react), we import it and write JSON.
// Assets are copied straight from public/.

import { build } from "esbuild";
import { mkdirSync, writeFileSync, readdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const DATA = join(root, "data");
const ASSETS = join(root, "assets");

// --- resolve source repo ---
const argSrc = process.argv.includes("--src") ? process.argv[process.argv.indexOf("--src") + 1] : null;
const SRC = argSrc ? (argSrc.startsWith("/") ? argSrc : join(process.cwd(), argSrc)) : join(root, "..", "hf-web-v2");
if (!existsSync(SRC)) { console.error(`❌ source repo not found: ${SRC}`); process.exit(1); }
console.log(`📦 source: ${SRC}\n`);

mkdirSync(DATA, { recursive: true });

// --- extract data modules ---
const EXTRACTS = [
  { file: "lib/config/plans.ts", picks: ["PLANS", "PHONE_NUMBER_PRICE", "PHONE_NUMBER_PRICE_INR"], out: "plans.json" },
  { file: "lib/cost-model.ts", picks: ["REP_DAY_COST", "DIALS_PER_REP_DAY", "CONNECT_RATE", "AVG_CALL_MIN", "WORKDAYS_PER_MONTH", "CONNECTS_PER_REP_DAY", "CONNECTS_PER_REP_MONTH", "DIALS_PER_CONNECT"], out: "human-cost.json" },
  { file: "lib/roi-calc.ts", picks: ["MANUAL_COST_PER_CONNECT_INR", "MANUAL_COST_PER_CONNECT_USD", "BENCHMARK_PICKUP_RATE", "INDUSTRY_AHT_MIN", "FALLBACK_CREDIT_RATE_INR"], out: "finn-roi.json" },
  { file: "lib/testimonials.ts", picks: ["TESTIMONIALS"], out: "testimonials.json" },
  { file: "lib/industries.ts", picks: ["INDUSTRIES", "INDUSTRY_TAGS", "FEATURED_INDUSTRIES"], out: "industries.json" },
  { file: "lib/platform.ts", picks: ["CAPABILITIES", "CAPABILITY_PAGES", "FEATURE_CATEGORIES", "FEATURES", "FEATURE_PAGES"], out: "capabilities.json" },
  { file: "lib/playbooks.ts", picks: ["PLAYBOOKS", "PLAYBOOK_CATEGORIES"], out: "playbooks.json" },
  { file: "lib/use-case-data.ts", picks: ["useCaseDataMap"], out: "usecases.json" },
  { file: "lib/template-usecase-mappings.ts", picks: ["templateUseCaseMappings"], out: "usecase-templates.json" },
  { file: "lib/voice-catalog.ts", picks: ["VOICE_CATALOG"], out: "voices.json" },
  { file: "lib/language-catalog.ts", picks: ["POPULAR_LANGUAGE_CATALOG", "POPULAR_LANGUAGE_NAMES", "LANGUAGE_FLAGS_BY_NAME"], out: "languages.json" },
  { file: "lib/pricing-faq-data.ts", picks: ["pricingFaqData"], out: "pricing-faq.json" },
  { file: "lib/config/finn-billing.ts", picks: ["FINN_BILLING"], out: "billing.json" },
  { file: "lib/seo/page-metadata.ts", picks: ["PAGE_SEO"], out: "taglines.json" }
];

async function extractModule(srcFile) {
  const entry = join(SRC, srcFile);
  if (!existsSync(entry)) { console.warn(`  ⚠ missing ${srcFile}`); return null; }
  // stub react/lucide/next so modules that import icon components still
  // load — we only want their exported data, not the JSX.
  const stub = {
    name: "stub",
    setup(b) {
      b.onResolve({ filter: /^(react|react-dom|next|next\/.*|lucide-react|@\/components\/.*)$/ },
        (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" },
        () => ({ contents: "module.exports = new Proxy({}, { get: () => () => null });", loader: "js" }));
    }
  };
  const res = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm",
    platform: "node", logLevel: "silent",
    alias: { "@": SRC }, plugins: [stub]
  });
  const code = res.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

async function syncData() {
  console.log("— content —");
  for (const ex of EXTRACTS) {
    try {
      const mod = await extractModule(ex.file);
      if (!mod) continue;
      const obj = {};
      for (const p of ex.picks) if (p in mod) obj[p] = mod[p];
      writeFileSync(join(DATA, ex.out), JSON.stringify(obj, null, 2));
      console.log(`  ✓ ${ex.out}  (${ex.picks.filter((p) => p in mod).join(", ")})`);
    } catch (e) {
      console.warn(`  ✗ ${ex.file}: ${e.message.split("\n")[0]}`);
    }
  }
}

// --- copy assets ---
function copyDir(srcRel, destAbs, filter = () => true, rename = (n) => n) {
  const s = join(SRC, srcRel);
  if (!existsSync(s)) { console.warn(`  ⚠ missing ${srcRel}`); return 0; }
  mkdirSync(destAbs, { recursive: true });
  let n = 0;
  for (const f of readdirSync(s)) {
    if (!filter(f)) continue;
    try { copyFileSync(join(s, f), join(destAbs, rename(f))); n++; } catch {}
  }
  return n;
}

function syncAssets() {
  console.log("\n— assets —");

  // product snaps: light variants only, strip the -light suffix
  rmSync(join(ASSETS, "snaps"), { recursive: true, force: true });
  const snaps = copyDir("public/_static/snaps", join(ASSETS, "snaps"),
    (f) => f.endsWith("-light.html"), (f) => f.replace("-light.html", ".html"));
  console.log(`  ✓ snaps (${snaps})`);

  // industry hero photos
  const hero = copyDir("public/_static/industry-hero", join(ASSETS, "industry-hero"),
    (f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
  console.log(`  ✓ industry-hero (${hero})`);

  // integration logos
  const logos = copyDir("public/logos", join(ASSETS, "logos"), (f) => f.endsWith(".svg"));
  console.log(`  ✓ logos (${logos})`);

  // agent avatars
  const av = copyDir("public/_static/avatars", join(ASSETS, "avatars"),
    (f) => /\.(jpg|jpeg|png)$/i.test(f));
  console.log(`  ✓ avatars (${av})`);

  // official brand kit
  mkdirSync(join(ASSETS, "brand"), { recursive: true });
  let brand = 0;
  const brandMap = [
    ["public/_static/marketing/assets/finn-logo.svg", "finn-logo.svg"],
    ["public/_static/marketing/assets/finn-logotype.svg", "finn-logotype.svg"],
    ["public/_static/marketing/assets/wave-1.svg", "wave-1.svg"],
    ["public/_static/marketing/assets/wave-2.svg", "wave-2.svg"],
    ["public/_static/marketing/assets/signature.svg", "signature.svg"],
    ["public/assets/og-image.png", "og-image.png"]
  ];
  for (const [rel, name] of brandMap) {
    const s = join(SRC, rel);
    if (existsSync(s)) { copyFileSync(s, join(ASSETS, "brand", name)); brand++; }
  }
  console.log(`  ✓ brand (${brand})`);

  // customer logos — globbed across per-industry dirs
  const names = ["frinks", "orbit", "snazzy", "rocket", "tofa", "pillar"];
  mkdirSync(join(ASSETS, "customers"), { recursive: true });
  let cust = 0;
  const statics = join(SRC, "public/_static");
  if (existsSync(statics)) {
    for (const d of readdirSync(statics)) {
      const dir = join(statics, d);
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".svg") && names.some((n) => f.toLowerCase().startsWith(n))) {
            const dest = join(ASSETS, "customers", f);
            if (!existsSync(dest)) { copyFileSync(join(dir, f), dest); cust++; }
          }
        }
      } catch {}
    }
  }
  console.log(`  ✓ customers (${cust})`);
}

await syncData();
syncAssets();
console.log("\n✅ sync complete. Review git diff and commit.\n");
