#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import { chromium } from "@playwright/test";

/**
 * Records the Scenario chat screenshot acceptance matrix.
 *
 * The five slugs, routes, and viewports are the ones the approved 7I
 * interaction map fixes in §11. Each shot waits for the state the route is
 * supposed to reach — `settled` for the scripted routes, `streaming` for the
 * staged capture — so a capture can never be a race.
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

/** 7I map §11 — the acceptance set reviewed before 7I is accepted. */
export const SCENARIO_CHAT_SHOTS = [
  { slug: "chat-home", route: "#/chat", state: null },
  { slug: "chat-session", route: "#/chat/ix-checkbox-01?replay=fake", state: "settled" },
  {
    slug: "chat-denied",
    route: "#/chat/ap-mcp-gate-01?replay=fake&view=activity&turn=2",
    state: "settled",
  },
  {
    slug: "chat-activity-diff",
    route: "#/chat/ix-checkbox-01?replay=fake&view=activity&turn=3",
    state: "settled",
  },
  {
    slug: "chat-streaming",
    route: "#/chat/ap-mcp-gate-01?replay=fake&stage=streaming",
    state: "streaming",
  },
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
  const overflows = [];
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
        for (const shot of SCENARIO_CHAT_SHOTS) {
          // A hash-only navigation would keep the previous session in memory,
          // so every capture starts from a clean document.
          await page.goto("about:blank");
          await page.goto(`${origin}/scenario-explorer/${shot.route}`);
          if (shot.state !== null) {
            await page.waitForSelector(
              `[data-testid="explorer-shell"][data-chat-state="${shot.state}"]`,
              { timeout: 30_000 },
            );
          }
          // A full-page capture stretches the viewport to the content height,
          // which leaves the sticky mobile composer floating mid-document and
          // misrepresents the reading order. Pinning is proven by the browser
          // spec; the evidence shot shows the layout in document order.
          await page.addStyleTag({
            content: ".pcr7-chat-composer { position: static !important; }",
          });
          // Expand the chat and activity disclosures so the matrix evidence is
          // visible: arguments, denial records, diff rows, parity assertions.
          // The picker's facets keep their default state — the rail is
          // navigation, not evidence.
          await page.evaluate(() => {
            for (const element of document.querySelectorAll("main details, aside details")) {
              element.setAttribute("open", "");
            }
          });
          // The 7I map makes "no horizontal page scroll" a hard gate, so the
          // recorder refuses to hand over a shot that violates it.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 0) overflows.push(`${shot.slug}-${viewport.label} (+${overflow}px)`);
          const path = resolve(evidenceDirectory, `scenario-chat-${shot.slug}-${viewport.label}.png`);
          await page.screenshot({ path, fullPage: true });
          captured.push(`scenario-chat-${shot.slug}-${viewport.label}.png`);
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
    resolve(evidenceDirectory, "scenario-chat-screenshot-manifest.json"),
    `${JSON.stringify(
      {
        schema: "paperclip.capability.screenshot-manifest.v1",
        source: "docs/design/scenario-chat-ux.md §11",
        viewports: VIEWPORTS.map((viewport) => viewport.label),
        shots: SCENARIO_CHAT_SHOTS,
        files: captured.sort(),
      },
      null,
      2,
    )}\n`,
  );
  if (overflows.length > 0) {
    throw new Error(`horizontal page scroll in: ${overflows.join(", ")}`);
  }
  process.stdout.write(`Recorded ${captured.length} Scenario chat chat screenshots.\n`);
}

await main();
