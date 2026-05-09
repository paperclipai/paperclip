import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../middleware/logger.js";

const COOKIE_CACHE = path.join(os.homedir(), ".paperclip", "bba-cookie-cache.json");
const CASA_URL     = "https://www.casapariurilor.ro/pariuri-online/fotbal";
const PROFILE_DIR  = path.join(os.homedir(), ".paperclip", "bba-playwright-profile");
const LOGIN_BTN    = ".header-login-wrapper.user-box-link";

// Check every 30 minutes — Casa's session timeout is ~2h; 30 min gives safe margin even during long BBA runs
const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

interface KeepaliveStatus {
  sessionStatus: "active" | "expired" | "unknown";
  cookieCount: number;
  lastCheckedAt: string | null;
  lastSessionActiveAt: string | null;
}

const status: KeepaliveStatus = {
  sessionStatus: "unknown",
  cookieCount: 0,
  lastCheckedAt: null,
  lastSessionActiveAt: null,
};

export function getKeepaliveStatus(): KeepaliveStatus {
  return { ...status };
}

// Ordered overlay selectors — "JOACĂ ÎN CONTINUARE" first: clicking it triggers site-side re-auth
const OVERLAY_SELECTORS = [
  "button:has-text('JOACĂ ÎN CONTINUARE')",
  "button:has-text('ACCEPT TOATE')",
  "button:has-text('Accept toate')",
  "button:has-text('DOAR CELE NECESARE')",
  "button:has-text('Romanian')",
  "button:has-text('Română')",
  "[class*='popup'] [class*='close']",
  "[class*='modal'] [class*='close']",
  ".modal-close",
  "button[aria-label='Close']",
  "button[aria-label='Inchide']",
  "[class*='promo'] button[class*='close']",
  "button:has-text('Sunt major')",
  "button:has-text('Am peste 18 ani')",
];

async function dismissOverlays(page: import("@playwright/test").Page): Promise<boolean> {
  let clickedJoaca = false;
  for (const sel of OVERLAY_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 2_000 });
        if (sel.includes("JOACĂ")) {
          // Site-side re-auth takes ~2.5s after button click
          await page.waitForTimeout(2_500);
          clickedJoaca = true;
        } else {
          await page.waitForTimeout(500);
        }
      }
    } catch { /* overlay not present */ }
  }
  return clickedJoaca;
}

async function clearProfileLocks(profileDir: string) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { await fs.unlink(path.join(profileDir, name)); } catch { /* ignore */ }
  }
}

async function saveCookies(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>): Promise<number> {
  const state = await context.storageState();
  await fs.writeFile(COOKIE_CACHE, JSON.stringify(state, null, 2), "utf8");
  return state.cookies.filter(c => c.domain.includes("casapariurilor")).length;
}

async function runKeepalive(): Promise<void> {
  logger.info("bba-keepalive: checking Casa session");
  status.lastCheckedAt = new Date().toISOString();

  await clearProfileLocks(PROFILE_DIR);
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    const page = context.pages()[0] ?? await context.newPage();

    // Inject fresh cached cookies on top of profile state
    try {
      const cached = JSON.parse(await fs.readFile(COOKIE_CACHE, "utf8"));
      if (Array.isArray(cached?.cookies) && cached.cookies.length > 0) {
        await context.addCookies(cached.cookies);
      }
    } catch { /* no cache yet */ }

    await page.goto(CASA_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    // Dismiss any overlays — if "Joacă în continuare" is clicked, site attempts its own re-auth
    const clickedJoaca = await dismissOverlays(page);
    if (clickedJoaca) {
      logger.info("bba-keepalive: clicked 'JOACĂ ÎN CONTINUARE' — site attempting auto-reauth");
      await page.waitForTimeout(3_000); // extra time for site-side re-auth to complete
    }

    let loginBtnVisible = await page.locator(LOGIN_BTN).isVisible().catch(() => false);
    let isLoggedIn = !loginBtnVisible;

    if (!isLoggedIn && clickedJoaca) {
      // Re-check after site re-auth
      loginBtnVisible = await page.locator(LOGIN_BTN).isVisible().catch(() => false);
      isLoggedIn = !loginBtnVisible;
      if (isLoggedIn) {
        logger.info("bba-keepalive: site auto-reauth succeeded after 'JOACĂ ÎN CONTINUARE'");
      }
    }

    if (isLoggedIn) {
      const count = await saveCookies(context);
      status.sessionStatus = "active";
      status.cookieCount = count;
      status.lastSessionActiveAt = new Date().toISOString();
      logger.info({ cookieCount: count }, "bba-keepalive: session active, cookies refreshed");
    } else {
      // Session expired and site re-auth did not restore it — try browser autofill via CDP
      logger.warn("bba-keepalive: session EXPIRED — attempting auto-relogin via browser autofill");
      const reloginOk = await attemptAutofillRelogin(page);
      if (reloginOk) {
        const count = await saveCookies(context);
        status.sessionStatus = "active";
        status.cookieCount = count;
        status.lastSessionActiveAt = new Date().toISOString();
        logger.info({ cookieCount: count }, "bba-keepalive: auto-relogin succeeded, session restored");
      } else {
        status.sessionStatus = "expired";
        logger.warn("bba-keepalive: auto-relogin failed — CAPTCHA/OTP suspected — run bba-login.mjs manually");
      }
    }
  } catch (err) {
    status.sessionStatus = "unknown";
    logger.warn({ err }, "bba-keepalive: error during session check");
  } finally {
    await context?.close().catch(() => undefined);
  }
}

// Attempts to log in via Chrome password manager autofill.
// Returns true if session is active after the attempt.
async function attemptAutofillRelogin(
  page: import("playwright").Page,
): Promise<boolean> {
  try {
    await dismissOverlays(page);

    // Click the CONECTARE header button to open the login modal
    const loginEntry = page.locator(LOGIN_BTN).first();
    const loginEntryVisible = await loginEntry.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!loginEntryVisible) {
      // Already logged in or modal opened by Joacă handler
      const stillLoggedOut = await page.locator(LOGIN_BTN).isVisible({ timeout: 2_000 }).catch(() => false);
      return stillLoggedOut === false;
    }

    await loginEntry.click({ timeout: 3_000 });
    await page.waitForTimeout(1_500); // wait for Chrome autofill

    // Check if username field was autofilled
    const usernameSelectors = ["input[type='text']", "input[placeholder*='utilizator' i]", "input[name*='user' i]"];
    let usernameField = null;
    for (const sel of usernameSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        usernameField = el;
        break;
      }
    }
    if (!usernameField) {
      logger.warn("bba-keepalive autofill: username field not found");
      return false;
    }
    const autofillValue = await usernameField.inputValue().catch(() => "");
    if (!autofillValue.trim()) {
      logger.warn("bba-keepalive autofill: username field empty — no browser-saved credentials");
      return false;
    }

    // Click submit
    const submitSelectors = [
      "button[class*='user-box-form-button']",
      "form button[type='submit']",
      "button:has-text('CONECTARE')",
      "button:has-text('Conectare')",
      ".modal button[type='submit']",
    ];
    let submitBtn = null;
    for (const sel of submitSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        submitBtn = el;
        break;
      }
    }
    if (!submitBtn) {
      logger.warn("bba-keepalive autofill: submit button not found");
      return false;
    }
    await submitBtn.click({ timeout: 3_000 });

    // Poll for 30s to see if login succeeded
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_000);
      const stillLoggedOut = await page.locator(LOGIN_BTN).isVisible({ timeout: 1_000 }).catch(() => false);
      if (!stillLoggedOut) return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err }, "bba-keepalive autofill: exception during relogin attempt");
    return false;
  }
}

export function startBbaSessionKeepalive() {
  if (keepaliveTimer) return; // already running

  logger.info({ intervalMs: KEEPALIVE_INTERVAL_MS }, "bba-keepalive: started");

  // Run immediately on startup to warm up the cache
  void runKeepalive();

  keepaliveTimer = setInterval(() => {
    void runKeepalive();
  }, KEEPALIVE_INTERVAL_MS);

  keepaliveTimer.unref(); // don't block process exit
}

export function stopBbaSessionKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    logger.info("bba-keepalive: stopped");
  }
}
