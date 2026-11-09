import { chromium, type Browser, type Page } from "@playwright/test";
import { UI_RETRY_BUTTON_MISSING, UI_RETRY_NO_REQUEST } from "./types.js";

export { UI_RETRY_BUTTON_MISSING, UI_RETRY_NO_REQUEST };

export interface UiRetryClick {
  clicked: boolean;
  httpStatus: number | null;
  accepted: boolean | null;
  error: string | null;
  bannerText: string | null;
}

export async function clickRetryOnPage(page: Page, url: string, timeoutMs: number): Promise<UiRetryClick> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const button = page.getByRole("button", { name: "Retry", exact: true }).first();
  const banner = async () => {
    const texts = await page.locator("[role=status], [role=alert]").allInnerTexts().catch(() => []);
    return texts.map(text => text.trim()).filter(Boolean).join(" | ").slice(0, 500) || null;
  };
  try {
    await button.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return { clicked: false, httpStatus: null, accepted: null, error: UI_RETRY_BUTTON_MISSING, bannerText: await banner() };
  }
  const bannerText = await banner();
  const response = page.waitForResponse(candidate => candidate.request().method() === "POST" && /\/api\/issues\/[^/]+\/retry$/.test(new URL(candidate.url()).pathname),
    { timeout: timeoutMs }).catch(() => null);
  await button.click();
  const answered = await response;
  if (!answered) return { clicked: true, httpStatus: null, accepted: null, error: UI_RETRY_NO_REQUEST, bannerText };
  const body = await answered.json().catch(() => null) as { accepted?: unknown } | null;
  return { clicked: true, httpStatus: answered.status(), accepted: answered.ok() ? body?.accepted === true : false,
    error: answered.ok() ? null : `retry request failed with ${answered.status()}`, bannerText };
}

export class BoardUi {
  private browser: Promise<Browser> | null = null;

  constructor(private readonly baseUrl: string, private readonly launch: () => Promise<Browser> = () => chromium.launch({ headless: true })) {}

  async clickRetry(identifier: string, timeoutMs = 60_000): Promise<UiRetryClick> {
    this.browser ??= this.launch();
    const context = await (await this.browser).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      return await clickRetryOnPage(await context.newPage(), `${this.baseUrl}/issues/${encodeURIComponent(identifier)}`, timeoutMs);
    } catch (error) {
      return { clicked: false, httpStatus: null, accepted: null, error: error instanceof Error ? error.message : String(error), bannerText: null };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) await (await browser).close().catch(() => undefined);
  }
}
