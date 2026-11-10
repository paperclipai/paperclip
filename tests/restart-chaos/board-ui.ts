import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type ElementHandle, type Page } from "@playwright/test";
import { UI_RETRY_BUTTON_MISSING, UI_RETRY_NO_REQUEST } from "./types.js";

export { UI_RETRY_BUTTON_MISSING, UI_RETRY_NO_REQUEST };

export interface UiRetryClick {
  clicked: boolean;
  httpStatus: number | null;
  accepted: boolean | null;
  error: string | null;
  bannerText: string | null;
  diagnostics?: { screenshot: string | null; dom: string | null } | null;
}

export async function saveRetryMissingDiagnostics(page: Page, directory: string, label: string) {
  const stem = path.join(directory, `ui-retry-missing-${label.replace(/[^A-Za-z0-9_-]+/g, "_")}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const screenshot = await page.screenshot({ path: `${stem}.png`, fullPage: true, timeout: 10_000 })
    .then(() => `${stem}.png`).catch(() => null);
  const banners = await page.locator("[role=status], [role=alert]")
    .evaluateAll(nodes => nodes.map(node => (node as Element).outerHTML.slice(0, 20_000))).catch(() => []);
  const buttons = [];
  for (const button of await page.getByRole("button", { name: "Retry", exact: true, includeHidden: true })
    .elementHandles().catch(() => [])) {
    buttons.push({
      visible: await button.isVisible().catch(() => null),
      box: await button.boundingBox().catch(() => null),
      inBanner: await button.evaluate(node => Boolean((node as Element).closest("[role=status], [role=alert]"))).catch(() => null),
      html: await button.evaluate(node => (node as Element).outerHTML.slice(0, 2_000)).catch(() => null),
    });
  }
  const dom = await writeFile(`${stem}.json`, JSON.stringify({ url: page.url(), savedAt: new Date().toISOString(),
    banners, retryButtons: buttons }, null, 2)).then(() => `${stem}.json`).catch(() => null);
  return { screenshot, dom };
}

const PER_BUTTON_REQUEST_MS = 5_000;

export function isRetryRequestFor(issueRefs: readonly string[], method: string, url: string): boolean {
  if (method !== "POST") return false;
  const match = /\/api\/issues\/([^/]+)\/retry$/.exec(new URL(url).pathname);
  return Boolean(match && issueRefs.includes(decodeURIComponent(match[1]!)));
}

async function retryButtonsBannerFirst(page: Page): Promise<ElementHandle[]> {
  const candidates: Array<{ button: ElementHandle; inBanner: boolean }> = [];
  for (const button of await page.getByRole("button", { name: "Retry", exact: true }).elementHandles()) {
    if (!await button.isVisible().catch(() => false)) continue;
    const inBanner = await button.evaluate(node => Boolean((node as Element).closest("[role=status], [role=alert]"))).catch(() => false);
    candidates.push({ button, inBanner });
  }
  return [...candidates.filter(candidate => candidate.inBanner), ...candidates.filter(candidate => !candidate.inBanner)].map(candidate => candidate.button);
}

export async function clickRetryOnPage(page: Page, url: string, issueRefs: readonly string[], timeoutMs: number,
  perButtonMs = PER_BUTTON_REQUEST_MS, diagnosticsDirectory: string | null = null): Promise<UiRetryClick> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const banner = async () => {
    const texts = await page.locator("[role=status], [role=alert]").allInnerTexts().catch(() => []);
    return texts.map(text => text.trim()).filter(Boolean).join(" | ").slice(0, 500) || null;
  };
  try {
    await page.getByRole("button", { name: "Retry", exact: true }).filter({ visible: true }).first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    const bannerText = await banner();
    const diagnostics = diagnosticsDirectory
      ? await saveRetryMissingDiagnostics(page, diagnosticsDirectory, issueRefs[0] ?? "issue").catch(() => null) : undefined;
    return { clicked: false, httpStatus: null, accepted: null, error: UI_RETRY_BUTTON_MISSING, bannerText,
      ...(diagnostics !== undefined ? { diagnostics } : {}) };
  }
  const bannerText = await banner();
  for (const button of await retryButtonsBannerFirst(page)) {
    const response = page.waitForResponse(candidate => isRetryRequestFor(issueRefs, candidate.request().method(), candidate.url()),
      { timeout: perButtonMs }).catch(() => null);
    await button.click().catch(() => undefined);
    const answered = await response;
    if (!answered) continue;
    const body = await answered.json().catch(() => null) as { accepted?: unknown } | null;
    return { clicked: true, httpStatus: answered.status(), accepted: answered.ok() ? body?.accepted === true : false,
      error: answered.ok() ? null : `retry request failed with ${answered.status()}`, bannerText };
  }
  return { clicked: true, httpStatus: null, accepted: null, error: UI_RETRY_NO_REQUEST, bannerText };
}

export class BoardUi {
  private browser: Promise<Browser> | null = null;

  constructor(private readonly baseUrl: string, private readonly launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
    private readonly diagnosticsDirectory: string | null = null) {}

  async clickRetry(identifier: string, issueId: string = identifier, timeoutMs = 60_000, perButtonMs = PER_BUTTON_REQUEST_MS): Promise<UiRetryClick> {
    let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
    try {
      this.browser ??= this.launch();
      context = await (await this.browser).newContext({ viewport: { width: 1440, height: 1000 } });
      return await clickRetryOnPage(await context.newPage(), `${this.baseUrl}/issues/${encodeURIComponent(identifier)}`,
        [identifier, issueId], timeoutMs, perButtonMs, this.diagnosticsDirectory);
    } catch (error) {
      return { clicked: false, httpStatus: null, accepted: null, error: error instanceof Error ? error.message : String(error), bannerText: null };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    try {
      await (await browser).close();
    } catch {
      return;
    }
  }
}
