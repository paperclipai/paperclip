/**
 * Manages a single persistent Playwright Chromium browser instance and page.
 *
 * One `SidecarBrowser` lives for the lifetime of the sidecar process. Pages are
 * not torn down between tool calls so state (cookies, storage) persists across
 * a session, which is required for login-once workflows.
 *
 * NOTE: Persistent Chromium sessions require `chromium.launchPersistentContext(userDataDir, …)`.
 * `browser.newContext({ userDataDir })` is NOT a valid Playwright API.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs/promises";

const DEFAULT_PROFILE_DIR = "/var/lib/surfer/profile";
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const LAUNCH_TIMEOUT_MS = 30_000;

export class SidecarBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private profileDir: string;

  constructor(profileDir?: string) {
    this.profileDir = profileDir ?? DEFAULT_PROFILE_DIR;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.profileDir, { recursive: true });

    // `launchPersistentContext` binds the userDataDir at launch time and returns
    // a BrowserContext directly — there is no separate Browser handle.
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      viewport: DEFAULT_VIEWPORT,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      timeout: LAUNCH_TIMEOUT_MS,
    });

    // Reuse the blank tab Chromium opens on start, or open a new one.
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0]! : await this.context.newPage();
  }

  async stop(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // Best-effort on shutdown
    }
    this.context = null;
    this.page = null;
  }

  getPage(): Page {
    if (!this.page) throw new Error("Browser not started — call start() first");
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error("Browser not started — call start() first");
    return this.context;
  }

  isRunning(): boolean {
    // launchPersistentContext doesn't expose a .browser(), but .isConnected()
    // exists on the Browser object returned from context.browser().
    return this.context !== null && this.context.browser()?.isConnected() !== false;
  }
}
