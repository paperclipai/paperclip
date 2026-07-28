#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const flags = parseFlags(process.argv.slice(2));
const source = flags.get("source") ?? "static";
const outDir = resolve(repoRoot, flags.get("out-dir") ?? "ui/deck-product-flow-captures");
const width = readPositiveInt(flags.get("width"), 1280);
const height = readPositiveInt(flags.get("height"), 720);
const theme = flags.get("theme") === "light" ? "light" : "dark";
const frames = readFrames(flags.get("frames") ?? "0,1,2,3");
const port = readPositiveInt(flags.get("port"), 6173);
let baseUrl = flags.get("base-url") ?? "";
let serverProcess = null;

if (source !== "static" && source !== "storybook") {
  throw new Error(`Unsupported --source ${source}. Use "static" or "storybook".`);
}

if (!baseUrl && source === "static") {
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(repoRoot, "scripts", "serve-deck-product-flow-static.mjs"), "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => process.stdout.write(chunk));
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForUrl(`${baseUrl}/deck-product-flow.html`);
} else if (!baseUrl) {
  baseUrl = "http://127.0.0.1:6006";
}

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const captures = [];

try {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  for (const frame of frames) {
    const url = buildUrl({ source, baseUrl, frame, theme });
    await page.goto(url, { waitUntil: "load" });
    await page.locator("[data-deck-product-flow-ready='true']").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const clipReport = await page.evaluate(() => {
      const documentReport = {
        id: "document",
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientWidth: window.innerWidth,
        clientHeight: window.innerHeight,
      };
      const panelReports = Array.from(
        document.querySelectorAll<HTMLElement>("[data-deck-product-flow-panel]"),
        (element) => ({
          id: element.dataset.deckProductFlowPanel ?? "panel",
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
        }),
      );
      return [documentReport, ...panelReports];
    });
    const clips = clipReport.some(
      (report) => report.scrollWidth > report.clientWidth || report.scrollHeight > report.clientHeight,
    );
    if (clips) {
      throw new Error(
        `Frame ${frame} clips: ${JSON.stringify(clipReport)}`,
      );
    }
    const filename = `deck-product-flow-frame-${String(frame).padStart(2, "0")}.png`;
    const filePath = join(outDir, filename);
    await page.screenshot({ path: filePath, fullPage: false, animations: "disabled" });
    captures.push({
      frame,
      file: filename,
      url,
      width,
      height,
      clips: false,
    });
  }
} finally {
  await browser.close();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
}

const manifest = {
  version: "deck-product-flow.v1",
  fixture: {
    seed: "paperclip:looa-767:deck-lab:2026-07-24",
    source: "ui/src/deck-product-flow/fixtures.ts",
  },
  capture: {
    source,
    theme,
    width,
    height,
    frames: captures,
  },
};

await writeFile(join(outDir, "deck-product-flow-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${captures.length} frames and manifest to ${outDir}`);

function parseFlags(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(key, "true");
    } else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

function readPositiveInt(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return number;
}

function readFrames(value) {
  const frames = value.split(",").map((item) => Number(item.trim()));
  if (frames.length === 0 || frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame > 3)) {
    throw new Error(`Expected --frames as comma-separated integers from 0 to 3, got ${value}`);
  }
  return frames;
}

function buildUrl({ source, baseUrl, frame, theme }) {
  if (source === "storybook") {
    return `${baseUrl}/iframe.html?id=product-deck-product-flow--captured-product-motion&viewMode=story&globals=theme:${theme}&args=initialFrame:${frame};mode:capture`;
  }
  return `${baseUrl}/deck-product-flow.html?mode=capture&frame=${frame}&theme=${theme}`;
}

async function waitForUrl(url) {
  const timeoutAt = Date.now() + 30_000;
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
