#!/usr/bin/env node
/**
 * Renders assets/icon.svg → src-tauri/icons/app-icon.png (1024×1024)
 * Then you run: pnpm --filter @paperclipai/desktop tauri icon src-tauri/icons/app-icon.png
 * which generates all required icon sizes (32, 128, 256, .icns, .ico …)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const svgPath = join(root, "assets", "icon.svg");
const outDir  = join(root, "src-tauri", "icons");
const outFile = join(outDir, "app-icon.png");

mkdirSync(outDir, { recursive: true });

// @resvg/resvg-js is a pure-WASM SVG renderer — no system dependencies needed
const { Resvg } = await import("@resvg/resvg-js");

const svg = readFileSync(svgPath, "utf-8");
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1024 },
  background: "rgba(0,0,0,0)",   // keep transparency (icns supports it)
});

const rendered = resvg.render();
const png      = rendered.asPng();

writeFileSync(outFile, png);
console.log(`✓  Generated  ${outFile}  (${rendered.width}×${rendered.height})`);
console.log();
console.log("Next step — generate all icon sizes:");
console.log("  pnpm --filter @paperclipai/desktop icon");
