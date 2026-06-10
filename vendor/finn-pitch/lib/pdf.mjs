// Bulletproof deck -> PDF: screenshot each live-rendered slide (so the deck's
// own fit/layout is exactly what the live viewer shows — nothing can overflow),
// then assemble the shots into a 16:9, one-page-per-slide PDF.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inlineAssets } from "./inline.mjs";

const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const chrome = (args, timeout) =>
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", ...args], { stdio: "ignore", timeout });

// rawHtml = the server-rendered deck HTML (CDN reveal, /snaps + /asset refs)
export function deckToPdf(rawHtml) {
  const slideCount = (rawHtml.match(/<section/gi) || []).length;
  if (!slideCount) throw new Error("no slides found");

  const dir = mkdtempSync(join(tmpdir(), "finn-pdf-"));
  try {
    // self-contained deck with on-screen chrome hidden, for clean shots
    const shot = inlineAssets(rawHtml).replace(
      "</head>",
      `<style>.reveal .controls,.reveal .progress,.reveal .slide-number{display:none!important}</style></head>`
    );
    const shotPath = join(dir, "shot.html");
    writeFileSync(shotPath, shot);

    // one screenshot per slide (live render → fit already applied)
    const pngs = [];
    for (let i = 0; i < slideCount; i++) {
      const png = join(dir, `s${String(i).padStart(3, "0")}.png`);
      chrome([
        "--hide-scrollbars", "--force-device-scale-factor=2",
        "--window-size=1280,720", "--virtual-time-budget=5000",
        `--screenshot=${png}`, `file://${shotPath}#/${i}`
      ], 30000);
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
    chrome([
      "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=10000", `--print-to-pdf=${pdfPath}`, `file://${asmPath}`
    ], 60000);

    return readFileSync(pdfPath);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
