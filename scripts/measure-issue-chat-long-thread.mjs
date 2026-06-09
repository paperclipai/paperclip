#!/usr/bin/env node

import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseUrl = (process.env.PAPERCLIP_PERF_BASE_URL || "http://localhost:3100").replace(/\/$/, "");
const companyPrefix = process.env.PAPERCLIP_PERF_COMPANY_PREFIX;
const url = companyPrefix
  ? `${baseUrl}/${companyPrefix}/tests/perf/long-thread`
  : `${baseUrl}/tests/perf/long-thread`;
const origin = new URL(url).origin;

function loadBoardToken() {
  const authPath = path.resolve(os.homedir(), ".paperclip/auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const credentials = auth.credentials || {};
    const matching = Object.values(credentials).find((entry) => {
      if (!entry || !entry.token || !entry.apiBase) return false;
      return new URL(entry.apiBase).origin === origin;
    });
    if (matching?.token) return matching.token;
    const fallback = Object.values(credentials).find((entry) => entry?.token);
    return fallback?.token ?? null;
  } catch {
    return null;
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const boardToken = process.env.PAPERCLIP_PERF_BEARER_TOKEN || loadBoardToken();

if (boardToken) {
  await page.route(`${origin}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), Authorization: `Bearer ${boardToken}` },
    });
  });
}

try {
  const startedAt = Date.now();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="issue-chat-long-thread-perf"]', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const target = Number(document.querySelector('[data-testid="perf-fixture-row-target"]')?.textContent ?? "450");
    const renderedRows = document.querySelectorAll('[data-testid="issue-chat-message-row"]').length;
    const virtualizer = document.querySelector('[data-testid="issue-chat-thread-virtualizer"]');
    if (!virtualizer) return renderedRows >= target;
    const virtualCount = Number(virtualizer.getAttribute("data-virtual-count") ?? "0");
    return virtualCount >= target && renderedRows > 0 && renderedRows < target;
  }, null, { timeout: 60_000 });
  const rowReadyMs = Date.now() - startedAt;

  const metrics = await page.evaluate(async () => {
    const text = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? "";
    const numericMs = (testId) => {
      const value = text(testId).replace(/\s*ms$/, "");
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const rowCount = document.querySelectorAll('[data-testid="issue-chat-message-row"]').length;
    const virtualizer = document.querySelector('[data-testid="issue-chat-thread-virtualizer"]');
    const virtualCount = Number(virtualizer?.getAttribute("data-virtual-count") ?? "0");
    const assistantRowCount = document.querySelectorAll('[data-testid="issue-chat-message-row"][data-message-role="assistant"]').length;
    const systemRowCount = document.querySelectorAll('[data-testid="issue-chat-message-row"][data-message-role="system"]').length;
    const userRowCount = document.querySelectorAll('[data-testid="issue-chat-message-row"][data-message-role="user"]').length;
    const markdownRows = Number(text("perf-fixture-markdown-rows"));
    const commitCount = Number(text("perf-commit-count"));
    const scrollStartY = window.scrollY;
    const scrollTarget = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const scrollStartedAt = performance.now();
    window.scrollTo({ top: scrollTarget, behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const scrollResponsiveMs = performance.now() - scrollStartedAt;

    return {
      url: window.location.href,
      fixtureRowTarget: Number(text("perf-fixture-row-target")),
      virtualized: Boolean(virtualizer),
      virtualCount,
      rowCount,
      assistantRowCount,
      userRowCount,
      systemRowCount,
      markdownRows,
      commitCount,
      mountActualDurationMs: numericMs("perf-mount-duration"),
      latestActualDurationMs: numericMs("perf-latest-duration"),
      maxActualDurationMs: numericMs("perf-max-duration"),
      totalActualDurationMs: numericMs("perf-total-duration"),
      reactProfilerAvailable: commitCount > 0,
      scrollResponsiveMs: Number(scrollResponsiveMs.toFixed(1)),
      scrollDeltaPx: Math.round(Math.abs(window.scrollY - scrollStartY)),
      documentHeightPx: Math.round(document.documentElement.scrollHeight),
    };
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({ ...metrics, renderReadyMs: rowReadyMs, elapsedMs }, null, 2));
} finally {
  await browser.close();
}
