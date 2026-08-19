#!/usr/bin/env node
/**
 * Captures clean-room chat evidence: a blank thread, a real Codex turn against
 * a fresh mock tenant, the on-demand evidence drawer, and the identity rotation
 * that `New chat` performs.
 *
 * Like the Capability live evidence, these PNGs sit outside the deterministic
 * §10.2 matrix on purpose — a real model writes the prose and the mock
 * identities are minted per session, so they are not byte-stable. They exist to
 * show the surface a board user actually meets.
 *
 * Requires an authenticated local Codex installation and a built runnerd.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(packageRoot, "knowledge/evidence/capability/clean-room");
const PORT = Number.parseInt(process.env.PAPERCLIP_CAPABILITY_CLEAN_ROOM_PORT ?? "4187", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const PROMPT =
  "Read this issue with get_task_context, then call report_progress with a one-sentence status. Do not ask me anything.";

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

async function assertNoHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => {
    const element = document.scrollingElement;
    return element.scrollWidth - element.clientWidth;
  });
  if (overflow > 0) throw new Error(`${label} scrolls horizontally by ${overflow}px`);
}

async function shot(page, name) {
  await page.screenshot({
    path: resolve(OUTPUT_DIR, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
  return `${name}.png`;
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
  const captured = [];
  try {
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    const context = await browser.newContext({
      viewport: DESKTOP,
      colorScheme: "dark",
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();

    // The scenario explorer is the landing surface; the clean room has to be
    // one click away from it without picking a scenario first.
    await page.goto(`${ORIGIN}/#/issue/hb-baseline?shot=thread-baseline`);
    await page.waitForSelector('[data-thread-state="settled"]', { timeout: 60_000 });
    captured.push(await shot(page, "clean-room-entry--desktop"));

    await page.getByTestId("surface-chat-link").click();
    // The explorer render is already settled, so the wait has to name the new
    // surface too — otherwise it matches the page we just navigated away from.
    await page.waitForSelector('[data-surface="chat"][data-thread-state="settled"]', {
      timeout: 180_000,
    });
    const firstIdentifier = await page.locator(".pit-identifier").innerText();
    const agentChip = await page.getByTestId("agent-chip").innerText();
    const runnerChip = await page.getByTestId("runner-chip").innerText();
    if (!agentChip.includes("Real Codex") || !runnerChip.includes("Real runnerd")) {
      throw new Error(`clean-room identity chips are wrong: ${agentChip} / ${runnerChip}`);
    }
    await page.waitForSelector('[data-testid="clean-room-empty"]');
    captured.push(await shot(page, "clean-room-blank--desktop"));

    await page.setViewportSize(MOBILE);
    await assertNoHorizontalScroll(page, "clean-room blank (mobile)");
    captured.push(await shot(page, "clean-room-blank--mobile"));
    await page.setViewportSize(DESKTOP);

    await page.fill("#composer-input", PROMPT);
    await page.getByTestId("composer-send").click();
    await page.waitForSelector('[data-thread-item="durable_comment"]', { timeout: 300_000 });
    await page.waitForSelector('[data-composer-state="ready"]', { timeout: 60_000 });
    captured.push(await shot(page, "clean-room-live-turn--desktop"));

    await page.getByTestId("evidence-toggle").click();
    await page.getByRole("button", { name: /Control plane/ }).click();
    captured.push(await shot(page, "clean-room-evidence--desktop"));
    await page.getByTestId("evidence-toggle").click();

    await page.setViewportSize(MOBILE);
    await assertNoHorizontalScroll(page, "clean-room live turn (mobile)");
    captured.push(await shot(page, "clean-room-live-turn--mobile"));
    await page.setViewportSize(DESKTOP);

    await page.getByTestId("new-chat-button").click();
    await page.waitForSelector('[data-testid="clean-room-empty"]', { timeout: 180_000 });
    const secondIdentifier = await page.locator(".pit-identifier").innerText();
    if (secondIdentifier === firstIdentifier) {
      throw new Error(`New chat did not rotate the mock identity (${secondIdentifier})`);
    }
    captured.push(await shot(page, "clean-room-new-chat--desktop"));

    await writeFile(
      resolve(OUTPUT_DIR, "index.md"),
      [
        "# Capability clean-room chat evidence",
        "",
        "Recorded by `pnpm --filter @paperclipai/paperclip-runner record:capability:cleanroom`.",
        "",
        "Real `paperclip-runnerd` and a real Codex app-server drive these frames against a",
        "freshly minted mock tenant. A real model writes the prose and the mock identities",
        "are minted per session, so these PNGs are **not** byte-stable and are excluded",
        "from the §10.2 determinism gate.",
        "",
        `First mock issue: \`${firstIdentifier}\`. After \`New chat\`: \`${secondIdentifier}\`.`,
        "",
        ...captured.map((name) => `- \`${name}\``),
        "",
      ].join("\n"),
      "utf8",
    );
    process.stdout.write(
      `Recorded ${captured.length} clean-room screenshots to ${OUTPUT_DIR} (${firstIdentifier} → ${secondIdentifier})\n`,
    );
    await context.close();
  } finally {
    await browser.close();
    child.kill("SIGTERM");
  }
}

await main();
