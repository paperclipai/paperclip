#!/usr/bin/env node
/**
 * Small, host-safe browser entrypoint for Paperclip tasks.
 *
 * It intentionally owns one short-lived, headless Chromium process at a time,
 * uses a throwaway profile, and removes both profile and lock on every exit.
 * This avoids cross-agent profile contention and browser-version drift from
 * ad-hoc global Playwright/MCP launches.
 */
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const lockPath = join(tmpdir(), "paperclip-managed-playwright.lock");

function usage() {
  return "Usage: node scripts/managed-playwright.mjs [--url <url>] [--screenshot <absolute-path>] [--timeout-ms <1000-60000>]";
}

function parseArgs(argv) {
  const result = {
    url: "data:text/html,<main><h1>managed-browser-smoke</h1></main>",
    screenshot: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--url" && value) {
      result.url = value;
      index += 1;
      continue;
    }
    if (key === "--screenshot" && value) {
      result.screenshot = resolve(value);
      index += 1;
      continue;
    }
    if (key === "--timeout-ms" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_TIMEOUT_MS) {
        throw new Error("--timeout-ms must be an integer between 1000 and 60000");
      }
      result.timeoutMs = parsed;
      index += 1;
      continue;
    }
    throw new Error(`${usage()}\nUnknown or incomplete option: ${key}`);
  }
  return result;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function headlessShellPathFrom(playwrightExecutable) {
  // macOS 26 aborts while the full Chrome-for-Testing app registers with
  // LaunchServices. The matching Playwright headless shell uses the same CDP
  // surface without that desktop-app startup path. Derive the build from the
  // repository-pinned Playwright executable so a package upgrade cannot drift
  // the browser choice.
  const match = playwrightExecutable.match(/^(.*)\/chromium-(\d+)\//);
  if (!match) {
    throw new Error(`Unable to derive a managed headless shell from Playwright executable: ${playwrightExecutable}`);
  }
  const [, cacheRoot, build] = match;
  const platformSegment = process.platform === "darwin"
    ? `chrome-headless-shell-mac-${process.arch === "arm64" ? "arm64" : "x64"}`
    : process.platform === "win32"
      ? "chrome-headless-shell-win64"
      : "chrome-headless-shell-linux64";
  const binary = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const candidate = join(cacheRoot, `chromium_headless_shell-${build}`, platformSegment, binary);
  if (!existsSync(candidate)) {
    throw new Error(`Managed headless shell is missing for Playwright build ${build}: ${candidate}. Install the matching chromium-headless-shell; do not fall back to Google Chrome for Testing.`);
  }
  return candidate;
}

async function acquireLock() {
  try {
    const handle = await open(lockPath, "wx");
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    const pid = Number(existing.trim());
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
      throw new Error(`managed browser is already in use by pid ${pid}; wait for it instead of launching another Chrome`);
    }
    await rm(lockPath, { force: true });
    const handle = await open(lockPath, "wx");
    await handle.close();
  }
  await writeFile(lockPath, `${process.pid}\n`, "utf8");
}

async function withTimeout(action, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`managed browser timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await acquireLock();
  const profile = await mkdtemp(join(tmpdir(), "paperclip-browser-profile-"));
  const executablePath = headlessShellPathFrom(chromium.executablePath());
  let context;
  try {
    const output = await withTimeout(async () => {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        executablePath,
        args: ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
      });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
      if (options.screenshot) await page.screenshot({ path: options.screenshot, fullPage: true });
      return {
        browserVersion: context.browser()?.version() ?? null,
        title: await page.title(),
        url: page.url(),
        screenshot: options.screenshot,
      };
    }, options.timeoutMs);
    process.stdout.write(`${JSON.stringify({ ok: true, ...output })}\n`);
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
    await rm(lockPath, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
