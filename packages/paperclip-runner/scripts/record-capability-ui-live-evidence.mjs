#!/usr/bin/env node
/**
 * Captures live-mode evidence: the browser driving a real runnerd + Codex pair
 * against the mock control plane.
 *
 * These PNGs are deliberately outside the deterministic §10.2 matrix — a real
 * model writes their prose, so they are not byte-stable. They exist to show
 * that the same surface renders a live session and that the identity chips make
 * live and fake sessions impossible to confuse.
 *
 * Requires an authenticated local Codex installation and `cargo` on PATH.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(packageRoot, "knowledge/evidence/capability/ui-live");
const PORT = Number.parseInt(process.env.PAPERCLIP_CAPABILITY_UI_LIVE_PORT ?? "4186", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const PROMPT =
  "Call get_task_context, then call report_progress with a one-sentence status. Do not ask me anything.";

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Still binding.
    }
    if (Date.now() > deadline) throw new Error(`preview server never answered on ${url}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function main() {
  const child = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--config", "vite.issue-thread.config.ts", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: packageRoot, stdio: "ignore", env: { ...process.env, NODE_ENV: "" } },
  );
  await waitForServer(ORIGIN);

  const browser = await chromium.launch({
    ...(process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH === undefined
      ? {}
      : { executablePath: process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH }),
  });
  try {
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/#/issue/hb-baseline?mode=live`);
    await page.waitForSelector('[data-thread-state="settled"]', { timeout: 120_000 });

    const agentChip = await page.getByTestId("agent-chip").innerText();
    const runnerChip = await page.getByTestId("runner-chip").innerText();
    if (!agentChip.includes("Real Codex") || !runnerChip.includes("Real runnerd")) {
      throw new Error(`live identity chips are wrong: ${agentChip} / ${runnerChip}`);
    }

    await page.fill("#composer-input", PROMPT);
    await page.getByTestId("composer-send").click();
    await page.waitForSelector('[data-thread-item="durable_comment"]', { timeout: 300_000 });
    await page.waitForSelector('[data-composer-state="ready"]', { timeout: 60_000 });

    await page.screenshot({
      path: resolve(OUTPUT_DIR, "live-codex-turn--desktop.png"),
      animations: "disabled",
      caret: "hide",
    });

    await page.getByTestId("evidence-toggle").click();
    await page.screenshot({
      path: resolve(OUTPUT_DIR, "live-codex-evidence--desktop.png"),
      animations: "disabled",
      caret: "hide",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("segment-thread").click();
    const overflow = await page.evaluate(() => {
      const element = document.scrollingElement;
      return element.scrollWidth - element.clientWidth;
    });
    if (overflow > 0) throw new Error(`live thread scrolls horizontally by ${overflow}px at 390px`);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, "live-codex-turn--mobile.png"),
      animations: "disabled",
      caret: "hide",
    });

    await writeFile(
      resolve(OUTPUT_DIR, "index.md"),
      [
        "# Capability issue-thread live evidence",
        "",
        "Recorded by `pnpm --filter @paperclipai/paperclip-runner record:capability:ui:live`.",
        "",
        "Real `paperclip-runnerd` and a real Codex app-server drive these frames against",
        "the deterministic mock control plane. A real model writes the prose, so these",
        "PNGs are **not** byte-stable and are excluded from the §10.2 determinism gate.",
        "",
        "- `live-codex-turn--desktop.png`",
        "- `live-codex-evidence--desktop.png`",
        "- `live-codex-turn--mobile.png`",
        "",
      ].join("\n"),
      "utf8",
    );
    process.stdout.write(`Recorded live Capability UI evidence to ${OUTPUT_DIR}\n`);
    await context.close();
  } finally {
    await browser.close();
    child.kill("SIGTERM");
  }
}

await main();
