#!/usr/bin/env node
/**
 * Records the Capability §10.2 screenshot matrix: 12 slugs × 2 viewports.
 *
 * Every route is deterministic `fake` mode served from package fixtures — no
 * provider, runnerd, or credential is involved, so the PNGs are safe evidence
 * and reproduce byte-for-byte from a clean checkout. `--check` re-records into
 * a scratch directory and compares bytes instead of overwriting.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { CAPABILITY_UI_SHOT_SLUGS } from "../dist/issue-thread/fixtures.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(packageRoot, "knowledge/evidence/capability/ui");
const PORT = Number.parseInt(process.env.PAPERCLIP_CAPABILITY_UI_PORT ?? "4185", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Slugs whose evidence needs an extra deep-link parameter. */
const EXTRA_PARAMS = {
  "debug-panel-open": { desktop: { panel: "authorization" }, mobile: { panel: "authorization", seg: "evidence" } },
  "replay-mode": { desktop: { at: "12" }, mobile: { at: "12" } },
};

function routeFor(slug, viewport) {
  const params = new URLSearchParams({
    shot: slug,
    capture: "1",
    ...(EXTRA_PARAMS[slug]?.[viewport] ?? {}),
  });
  return `${ORIGIN}/#/issue/hb-baseline?${params.toString()}`;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still binding.
    }
    if (Date.now() > deadline) throw new Error(`preview server never answered on ${url}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function startPreview() {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--config",
      "vite.issue-thread.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
    ],
    { cwd: packageRoot, stdio: "ignore", env: { ...process.env, NODE_ENV: "" } },
  );
  await waitForServer(ORIGIN);
  return async () => {
    child.kill("SIGTERM");
  };
}

// Set by `record` so a drift report can name the Chromium build that produced it.
let browserVersion = "unknown";
let fontProbe = {
  sansFamily: "Paperclip Issue Thread Inter",
  monoFamily: "Paperclip Issue Thread DejaVu Sans Mono",
  symbolFamily: "Paperclip Issue Thread Symbols",
  interWidth: 0,
  serifWidth: 0,
  monoWidth: 0,
  sansStatuses: [],
  monoStatuses: [],
  symbolStatuses: [],
  interResolves: false,
  monoResolves: false,
  symbolsResolve: false,
};

/**
 * Prove that the Vite-managed font faces registered and loaded from the built
 * bundle. The family names are package-specific, so an ambient host font can
 * never make this probe pass when either asset is missing.
 */
async function probeFonts(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(routeFor("thread-baseline", "desktop"));
  await page.waitForSelector('[data-thread-state="settled"]', { timeout: 30_000 });
  const probe = await page.evaluate(async () => {
    const normalizeFamily = (family) => family.trim().replace(/^['"]|['"]$/g, "");
    const styles = getComputedStyle(document.documentElement);
    const sansFamily = normalizeFamily(styles.getPropertyValue("--pit-font-sans").split(",")[0]);
    const monoFamily = normalizeFamily(styles.getPropertyValue("--pit-font-mono").split(",")[0]);
    const symbolFamily = normalizeFamily(styles.getPropertyValue("--pit-font-symbols"));
    const sample = "Wire the runner spike to the mock control plane";
    const requested = [
      ...[400, 500, 600, 700].map((weight) => ({ family: sansFamily, weight })),
      ...[400, 700].map((weight) => ({ family: monoFamily, weight })),
      { family: symbolFamily, weight: 400, sample: "◐⏳\uFE0E" },
    ];
    const loadResults = await Promise.all(
      requested.map(async ({ family, weight, sample: faceSample }) => {
        try {
          const loaded = await document.fonts.load(
            `${weight} 24px "${family}"`,
            faceSample ?? sample,
          );
          return loaded.length > 0;
        } catch {
          return false;
        }
      }),
    );
    await document.fonts.ready;

    const faceStatuses = (family) =>
      [...document.fonts]
        .filter((face) => normalizeFamily(face.family) === family)
        .map((face) => face.status);
    const canvas = document.createElement("canvas").getContext("2d");
    const width = (font) => {
      canvas.font = font;
      return Math.round(canvas.measureText(sample).width);
    };
    const sansStatuses = faceStatuses(sansFamily);
    const monoStatuses = faceStatuses(monoFamily);
    const symbolStatuses = faceStatuses(symbolFamily);
    return {
      sansFamily,
      monoFamily,
      symbolFamily,
      interWidth: width(`700 24px "${sansFamily}"`),
      serifWidth: width("700 24px serif"),
      monoWidth: width(`400 24px "${monoFamily}"`),
      sansStatuses,
      monoStatuses,
      symbolStatuses,
      interResolves:
        sansFamily === "Paperclip Issue Thread Inter" &&
        sansStatuses.length === 1 &&
        sansStatuses.every((status) => status === "loaded") &&
        loadResults.slice(0, 4).every(Boolean),
      monoResolves:
        monoFamily === "Paperclip Issue Thread DejaVu Sans Mono" &&
        monoStatuses.length === 2 &&
        monoStatuses.every((status) => status === "loaded") &&
        loadResults.slice(4, 6).every(Boolean),
      symbolsResolve:
        symbolFamily === "Paperclip Issue Thread Symbols" &&
        symbolStatuses.length === 2 &&
        symbolStatuses.every((status) => status === "loaded") &&
        loadResults[6] === true,
    };
  });
  await context.close();
  return probe;
}

async function record(targetDir) {
  await mkdir(targetDir, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH === undefined
      ? {}
      : { executablePath: process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH }),
  });
  browserVersion = browser.version();
  const recorded = [];
  try {
    fontProbe = await probeFonts(browser);
    if (!fontProbe.interResolves || !fontProbe.monoResolves || !fontProbe.symbolsResolve) {
      throw new Error(
        "bundled font asset mismatch: the Capability issue-thread faces did not load " +
          `from the built bundle (sans ${fontProbe.sansFamily}: ${fontProbe.sansStatuses.join(",") || "missing"}; ` +
          `mono ${fontProbe.monoFamily}: ${fontProbe.monoStatuses.join(",") || "missing"}; ` +
          `symbols ${fontProbe.symbolFamily}: ${fontProbe.symbolStatuses.join(",") || "missing"}). ` +
          "Run build:issue-thread and verify that Vite emitted all referenced WOFF2 assets.",
      );
    }
    for (const viewport of VIEWPORTS) {
      for (const slug of CAPABILITY_UI_SHOT_SLUGS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          colorScheme: "dark",
          locale: "en-US",
          timezoneId: "UTC",
        });
        const page = await context.newPage();
        await page.goto(routeFor(slug, viewport.name));
        // Settle on the contract's data attribute, never on a timeout.
        await page.waitForSelector('[data-thread-state="settled"]', { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);

        const overflow = await page.evaluate(() => {
          const element = document.scrollingElement;
          return element.scrollWidth - element.clientWidth;
        });
        if (viewport.name === "mobile" && overflow > 0) {
          throw new Error(`${slug} scrolls horizontally by ${overflow}px at 390px`);
        }

        const file = resolve(targetDir, `${slug}--${viewport.name}.png`);
        await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
        recorded.push({ slug, viewport: viewport.name, file, overflow });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return recorded;
}

async function main() {
  const check = process.argv.includes("--check");
  const stop = await startPreview();
  try {
    if (!check) {
      await rm(OUTPUT_DIR, { recursive: true, force: true });
      const recorded = await record(OUTPUT_DIR);
      const manifest = recorded.map(({ slug, viewport }) => `${slug}--${viewport}.png`).sort();
      await writeFile(
        resolve(OUTPUT_DIR, "index.md"),
        [
          "# Capability issue-thread UI evidence",
          "",
          "Recorded by `pnpm --filter @paperclipai/paperclip-runner record:capability:ui`.",
          "Deterministic `fake` mode; no provider, runner, or credential is involved.",
          "",
          ...manifest.map((name) => `- \`${name}\``),
          "",
          "## Recording environment",
          "",
          `- Chromium ${browserVersion} — pin the exact binary with \`PAPERCLIP_CHROMIUM_BIN\``,
          "  (honoured by the agent-browser wrapper) alongside",
          "  `PAPERCLIP_RUNNER_CHROMIUM_PATH`.",
          `- Bundled sans face: ${fontProbe.sansFamily} (weights 400/500/600/700,`,
          `  probe ${fontProbe.interWidth}px vs generic serif ${fontProbe.serifWidth}px).`,
          `- Bundled mono face: ${fontProbe.monoFamily} (weights 400/700,`,
          `  probe ${fontProbe.monoWidth}px). Status glyphs use the bundled`,
          `  ${fontProbe.symbolFamily} subsets. The recorder refuses to run when any`,
          "  Vite-managed face is missing or fails to load.",
          "",
        ].join("\n"),
        "utf8",
      );
      process.stdout.write(`Recorded ${recorded.length} Capability UI screenshots to ${OUTPUT_DIR}\n`);
      return;
    }

    const scratchRoot =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const scratch = await mkdtemp(resolve(scratchRoot, "capability-ui-check-"));
    try {
      const recorded = await record(scratch);
      const drift = [];
      for (const entry of recorded) {
        const committed = resolve(OUTPUT_DIR, `${entry.slug}--${entry.viewport}.png`);
        const [expected, actual] = await Promise.all([
          readFile(committed).catch(() => null),
          readFile(entry.file),
        ]);
        if (expected === null || !expected.equals(actual)) {
          drift.push(`${entry.slug}--${entry.viewport}.png`);
        }
      }
      const committedNames = (await readdir(OUTPUT_DIR).catch(() => [])).filter((name) =>
        name.endsWith(".png"),
      );
      if (committedNames.length !== recorded.length) {
        drift.push(
          `expected ${recorded.length} committed PNGs, found ${committedNames.length}`,
        );
      }
      if (drift.length > 0) {
        process.stderr.write(
          [
            "Capability UI evidence is not byte-stable:",
            ...drift,
            "",
            `Recorded with Chromium ${browserVersion}; bundled Inter probe=${fontProbe.interWidth}px, mono=${fontProbe.monoWidth}px.`,
            "Committed PNGs are pinned to one Chromium build; their fonts are bundled.",
            "A wholesale mismatch usually means a different browser build, not ambient",
            "fontconfig state: set PAPERCLIP_RUNNER_CHROMIUM_PATH (and",
            "PAPERCLIP_CHROMIUM_BIN for the wrapper) to the Chromium that recorded them.",
            "",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `All ${recorded.length} Capability UI screenshots reproduce byte-for-byte.\n`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    await stop();
  }
}

await main();
