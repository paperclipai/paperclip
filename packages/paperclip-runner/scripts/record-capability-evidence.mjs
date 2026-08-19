#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createServer } from "node:net";

import { chromium } from "@playwright/test";

/**
 * Records the Capability screenshot acceptance matrix.
 *
 * The twelve slugs, routes, and viewports are the ones the approved
 * interaction map fixes in §9; each shot is taken only after the shell
 * reports `data-run-state="settled"`, so captures are reproducible.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(packageRoot, "knowledge/evidence/capability");
/**
 * Shared dev hosts routinely have the 418x/419x range occupied, so the
 * recorder binds an ephemeral port rather than competing for a fixed one.
 */
async function freePort() {
  const explicit = process.env.CAPABILITY_EVIDENCE_PORT;
  if (explicit !== undefined) return Number(explicit);
  return await new Promise((settle, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => settle(port));
    });
  });
}

const VIEWPORTS = [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "390x844", width: 390, height: 844 },
];

/** UX map §9 — the acceptance set reviewed before 7F is accepted. */
export const CAPABILITY_SHOTS = [
  { slug: "explorer-home", route: "#/" },
  {
    slug: "picker-filtered",
    route: "#/?group=ix&disposition=always_agent_tool&parity=not_run",
  },
  { slug: "hb-heartbeat", route: "#/case/hb-scoped-wake-01?run=fake&view=transcript" },
  { slug: "wk-planning", route: "#/case/wk-plan-directive-01?run=fake&view=transcript" },
  { slug: "bl-blockers-diff", route: "#/case/bl-create-blocked-01?run=fake&view=diff" },
  { slug: "ap-approval-denied", route: "#/case/ap-mcp-gate-01?run=fake&view=authorization" },
  { slug: "ar-artifacts", route: "#/case/ar-upload-before-done-01?run=fake&view=transcript" },
  { slug: "ix-interaction", route: "#/case/ix-checkbox-01?run=fake&view=transcript" },
  { slug: "rf-manager", route: "#/case/rf-api-mgr-heartbeat-01?run=fake&view=context" },
  { slug: "mh-multihop", route: "#/case/mh-subtask-tree-01?run=fake&view=parity" },
  { slug: "rs-restraint", route: "#/case/rs-question-only-01?run=fake&view=parity" },
  { slug: "rs-secret-redaction", route: "#/case/rs-secret-hygiene-01?run=fake&view=transcript" },
];

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((settle) => setTimeout(settle, 250));
  }
  throw new Error(`explorer did not start on ${url}`);
}

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "--config",
      "vite.scenarios.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: packageRoot, stdio: "ignore" },
  );

  const captured = [];
  try {
    await waitForServer(`${origin}/scenario-explorer/`, 60_000);
    const browser = await chromium.launch();
    try {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        for (const shot of CAPABILITY_SHOTS) {
          // A hash-only navigation would keep the previous shot's run results
          // in memory, and their parity dots would leak into this shot's
          // picker. Every capture starts from a clean document.
          await page.goto("about:blank");
          await page.goto(`${origin}/scenario-explorer/${shot.route}`);
          await page.waitForSelector('[data-testid="explorer-shell"][data-run-state="settled"]', {
            timeout: 30_000,
          });
          // Expand the run view and inspector so the matrix evidence is
          // visible: argument payloads, decision records, redaction chips,
          // diff rows. The picker's facets keep their default state — the
          // rail is navigation, not evidence.
          await page.evaluate(() => {
            for (const element of document.querySelectorAll("main details, aside details")) {
              element.setAttribute("open", "");
            }
          });
          const path = resolve(evidenceDirectory, `${shot.slug}-${viewport.label}.png`);
          await page.screenshot({ path, fullPage: true });
          captured.push(`${shot.slug}-${viewport.label}.png`);
          process.stdout.write(`captured ${shot.slug} at ${viewport.label}\n`);
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }

  await writeFile(
    resolve(evidenceDirectory, "screenshot-manifest.json"),
    `${JSON.stringify(
      {
        schema: "paperclip.capability.screenshot-manifest.v1",
        source: "docs/design/capability-scenario-explorer-ux.md §9",
        viewports: VIEWPORTS.map((viewport) => viewport.label),
        shots: CAPABILITY_SHOTS,
        files: captured.sort(),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Recorded ${captured.length} Capability explorer screenshots.\n`);
}

await main();
