#!/usr/bin/env node
/**
 * Small, host-safe browser entrypoint for Paperclip tasks.
 *
 * It intentionally owns one short-lived, headless Chromium process at a time,
 * uses a throwaway profile, and removes both profile and lock on every exit.
 * This avoids cross-agent profile contention and browser-version drift from
 * ad-hoc global Playwright/MCP launches.
 */
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
  let context;
  try {
    const output = await withTimeout(async () => {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
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
