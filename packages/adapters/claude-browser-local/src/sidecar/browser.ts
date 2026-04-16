/**
 * Manages a single persistent Playwright Chromium browser instance and page.
 *
 * One `SidecarBrowser` lives for the lifetime of the sidecar process. Pages are
 * not torn down between tool calls so state (cookies, storage) persists across
 * a session, which is required for login-once workflows.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";

const DEFAULT_PROFILE_DIR = "/var/lib/surfer/profile";
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const LAUNCH_TIMEOUT_MS = 30_000;

export class SidecarBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private profileDir: string;

  constructor(profileDir?: string) {
    this.profileDir = profileDir ?? DEFAULT_PROFILE_DIR;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.profileDir, { recursive: true });

    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      timeout: LAUNCH_TIMEOUT_MS,
    });

    this.context = await this.browser.newContext({
      userDataDir: this.profileDir,
      viewport: DEFAULT_VIEWPORT,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    this.page = await this.context.newPage();
  }

  async stop(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // Best-effort on shutdown
    }
    this.browser = null;
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
    return this.browser !== null && this.browser.isConnected();
  }
}
