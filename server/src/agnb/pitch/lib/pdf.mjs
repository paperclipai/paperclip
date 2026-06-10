// Bulletproof deck -> PDF: screenshot each live-rendered slide (so the deck's
// own fit/layout is exactly what the live viewer shows — nothing can overflow),
// then assemble the shots into a 16:9, one-page-per-slide PDF.
//
// Ported from finn-pitch. Adapted for AGNB: the deck HTML references assets via
// public-bucket URLs (storage.googleapis.com) and reveal.js via CDN, so headless
// Chrome fetches everything over the network — no local-asset inlining needed.
//
// Dev-only: requires a Chrome/Chromium binary. Absent on Cloud Run → the route
// returns 503, same contract as pitch generation.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve a Chrome binary: explicit override, then common macOS / Linux paths.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      readFileSync(p); // throws if missing/unreadable
      return p;
    } catch {
      // try next
    }
  }
  // Surface a recognizable message so the route can map it to a 503.
  const e = new Error("chrome not found (set CHROME_PATH); PDF export is dev-only");
  e.code = "ENOENT";
  throw e;
}

const chrome = (bin, args, timeout) =>
  execFileSync(bin, ["--headless=new", "--disable-gpu", ...args], { stdio: "ignore", timeout });

// rawHtml = the server-rendered deck HTML (CDN reveal, bucket asset refs)
export function deckToPdf(rawHtml) {
  const slideCount = (rawHtml.match(/<section/gi) || []).length;
  if (!slideCount) throw new Error("no slides found");

  const bin = resolveChrome();
  const dir = mkdtempSync(join(tmpdir(), "agnb-pdf-"));
  try {
    // hide on-screen chrome (controls/progress/slide-number) for clean shots.
    // Assets + reveal load over the network straight from their URLs.
    const shot = rawHtml.replace(
      "</head>",
      `<style>.reveal .controls,.reveal .progress,.reveal .slide-number{display:none!important}</style></head>`,
    );
    const shotPath = join(dir, "shot.html");
    writeFileSync(shotPath, shot);

    // one screenshot per slide (live render → fit already applied). Larger
    // virtual-time budget than finn's local build to absorb network fetches.
    const pngs = [];
    for (let i = 0; i < slideCount; i++) {
      const png = join(dir, `s${String(i).padStart(3, "0")}.png`);
      chrome(
        bin,
        [
          "--hide-scrollbars",
          "--force-device-scale-factor=2",
          "--window-size=1280,720",
          "--virtual-time-budget=8000",
          `--screenshot=${png}`,
          `file://${shotPath}#/${i}`,
        ],
        30000,
      );
      pngs.push(png);
    }

    // assemble shots into a paginated PDF (images can't overflow → always clean)
    const body = pngs.map((p) => `<img src="file://${p}">`).join("");
    const asm = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{ size:1280px 720px; margin:0; }
html,body{ margin:0; padding:0; }
img{ display:block; width:1280px; height:720px; page-break-after:always; }
img:last-child{ page-break-after:auto; }
</style></head><body>${body}</body></html>`;
    const asmPath = join(dir, "assemble.html");
    writeFileSync(asmPath, asm);
    const pdfPath = join(dir, "out.pdf");
    chrome(
      bin,
      [
        "--no-pdf-header-footer",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=10000",
        `--print-to-pdf=${pdfPath}`,
        `file://${asmPath}`,
      ],
      60000,
    );

    return readFileSync(pdfPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
