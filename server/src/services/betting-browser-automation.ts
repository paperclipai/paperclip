import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import type { Db } from "@paperclipai/db";
import { bettingPlacedBets, bettingPredictions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { bettingStopLossService, type StopLossPreflightResult } from "./betting-stop-loss.js";

const COOKIE_CACHE_PATH = path.join(
  process.env.USERPROFILE ?? os.homedir(),
  ".paperclip",
  "bba-cookie-cache.json",
);

const DEFAULT_ACTION_DELAY_MIN_MS = 3_000;
const DEFAULT_ACTION_DELAY_MAX_MS = 15_000;
const DEFAULT_MIN_CLICK_INTERVAL_MS = 3_000;
const DEFAULT_RETRY_DELAY_MIN_MS = 20_000;
const DEFAULT_RETRY_DELAY_MAX_MS = 30_000;
const DEFAULT_PAGE_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60 * 1000;
const PROFILE_LOCK_FILE_NAMES = new Set([
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
]);
const PROFILE_CACHE_PATH_SEGMENTS = new Set([
  "cache",
  "cache_data",
  "code cache",
  "dawncache",
  "gpucache",
  "grshadercache",
  "graphitedawncache",
]);

const CHROMIUM_STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=TranslateUI",
  // Suppress "Chrome didn't shut down correctly" crash recovery dialog
  "--disable-session-crashed-bubble",
  "--restore-last-session=0",
];

const COMMON_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];
const CASA_UNAUTHENTICATED_TEXT_SELECTORS = [
  "text=/Utilizatorul nu este autentificat/i",
  "text=/Nu esti autentificat/i",
  "text=/Nu ești autentificat/i",
];
const CASA_ACCOUNT_UNAUTHENTICATED_TITLE_PATTERN = /înregistrare casa pariurilor/i;
const GENERIC_BETSLIP_ACTIVE_SELECTORS = [
  "[data-test='betslip-selections']",
  "[data-test='betslip-coupon']",
  "[data-test='betslip-placement-button']",
  "[data-test='betslip-payin-input']",
  "[class*='betslip__selection']",
  "[class*='betslip__event']",
];
export const DEFAULT_BBA_FIREFOX_PROFILE = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "Mozilla",
  "Firefox",
  "Profiles",
  "a8jg7amv.paperclip-bba",
);
export const DEFAULT_BBA_CHROMIUM_PROFILE = path.join(
  os.homedir(),
  ".paperclip",
  "bba-playwright-profile",
);

export interface BettingAutomationSecretRef {
  secretId?: string | null;
  secretName?: string | null;
}

export interface BettingAutomationBetInput {
  predictionId?: string | null;
  matchLabel: string;
  market: string;
  selection: string;
  selectionHint?: string | null;
  marketHint?: string | null;
  odds: number;
  stake: number;
  currency?: string | null;
  eventUrl?: string | null;
  searchQuery?: string | null;
}

export interface BettingAutomationSelectorSet {
  selectors: string[];
  optional?: boolean;
}

export interface BettingAutomationBookmakerConfig {
  bookmaker: string;
  baseUrl: string;
  loginUrl: string;
  postLoginUrl?: string | null;
  historyUrl?: string | null;
  username: BettingAutomationSelectorSet;
  password: BettingAutomationSelectorSet;
  loginSubmit: BettingAutomationSelectorSet;
  loginSuccess?: BettingAutomationSelectorSet;
  loginFailure?: BettingAutomationSelectorSet;
  cookieAccept?: BettingAutomationSelectorSet;
  popupClose?: BettingAutomationSelectorSet;
  searchInput?: BettingAutomationSelectorSet;
  searchSubmit?: BettingAutomationSelectorSet;
  searchResult?: BettingAutomationSelectorSet;
  marketGroup?: BettingAutomationSelectorSet;
  selectionButton: BettingAutomationSelectorSet;
  stakeInput: BettingAutomationSelectorSet;
  reviewButton: BettingAutomationSelectorSet;
  submitButton?: BettingAutomationSelectorSet;
  receiptSuccess?: BettingAutomationSelectorSet;
  reviewSummary?: BettingAutomationSelectorSet;
  historyReady?: BettingAutomationSelectorSet;
  historySelection?: BettingAutomationSelectorSet;
}

export interface BettingAutomationRiskControls {
  maxStakePerBet: number;
  maxTotalStakePerSession: number;
  requireFinalConfirmation?: boolean;
  dailyStopLossPct?: number;
  sessionStopLossPct?: number;
}

export interface BettingAutomationExecutionOptions {
  finalConfirmation?: {
    confirmed: boolean;
    confirmedBy?: string | null;
    approvedOdds?: number | null;
    oddsDriftTolerancePct?: number | null;
  } | null;
  browserName?: "chromium" | "firefox";
  userDataDir?: string | null;
  headless?: boolean;
  skipLogin?: boolean;
  startUrl?: string | null;
  sessionTimeoutMs?: number;
  pageTimeoutMs?: number;
  actionDelayMinMs?: number;
  actionDelayMaxMs?: number;
  retryDelayMinMs?: number;
  retryDelayMaxMs?: number;
  minClickIntervalMs?: number;
  sessionLabel?: string | null;
}

export interface BettingAutomationRequest {
  companyId: string;
  issueId?: string | null;
  currentBalance?: number | null;
  sessionStartedAt?: string | Date | null;
  loginUsername: BettingAutomationSecretRef;
  loginPassword: BettingAutomationSecretRef;
  bookmakerConfig: BettingAutomationBookmakerConfig;
  bet: BettingAutomationBetInput;
  bets?: BettingAutomationBetInput[];
  riskControls: BettingAutomationRiskControls;
  execution?: BettingAutomationExecutionOptions | null;
}

export interface BettingAutomationSessionSummary {
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  currency: string;
  bookmaker: string;
  confirmedBy: string | null;
  bets?: BettingAutomationBetInput[];
}

export interface BettingAutomationResult {
  status: "awaiting_confirmation" | "completed" | "submitted_unconfirmed" | "failed" | "blocked_by_risk" | "session_expired";
  sessionId: string;
  summary: BettingAutomationSessionSummary;
  artifactDir: string;
  logPath: string;
  screenshots: string[];
  videoDir: string;
  reviewSummaryText: string | null;
  placedBetId: string | null;
  risk: StopLossPreflightResult;
  failureReason: string | null;
}

type BettingAutomationExecutionStatus = Exclude<
  BettingAutomationResult["status"],
  "awaiting_confirmation" | "failed" | "blocked_by_risk" | "session_expired"
>;

type BettingAutomationExecutionLedger = {
  issueId: string | null;
  sessionId: string;
  artifactDir: string;
  logPath: string;
  bookmaker: string;
  matchLabel: string;
  market: string;
  intendedSelection: string;
  selectionHint: string | null;
  matchedSelection: string | null;
  eventUrl: string | null;
  stake: number;
  currency: string;
  requestedOdds: number;
  approvedOdds: number | null;
  acceptedOdds: number | null;
  reviewSummaryText: string | null;
  currentBalanceBefore: number | null;
  currentBalanceAfter: number | null;
  executionStatus: BettingAutomationExecutionStatus;
  placedAt: string;
  confirmedBy: string | null;
};

type PlaywrightModule = typeof import("@playwright/test");

type ServiceDeps = {
  resolveSecret: (
    companyId: string,
    ref: BettingAutomationSecretRef,
  ) => Promise<string>;
  sendAlert?: (text: string) => Promise<void>;
  playwright?: PlaywrightModule;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type RuntimeConfig = {
  pageTimeoutMs: number;
  sessionTimeoutMs: number;
  actionDelayMinMs: number;
  actionDelayMaxMs: number;
  retryDelayMinMs: number;
  retryDelayMaxMs: number;
  minClickIntervalMs: number;
  headless: boolean;
};

type SessionPaths = {
  root: string;
  screenshotsDir: string;
  videoDir: string;
  logPath: string;
};

type LaunchedBrowserSession = {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  mode: "persistent_context" | "cdp";
  chromeProcess: ReturnType<typeof spawn> | null;
};

export function renderSelectorTemplate(template: string, bet: BettingAutomationBetInput) {
  return template
    .replaceAll("{{matchLabel}}", bet.matchLabel)
    .replaceAll("{{market}}", bet.market)
    .replaceAll("{{selection}}", bet.selection)
    .replaceAll("{{searchQuery}}", bet.searchQuery ?? bet.matchLabel);
}

function selectorTemplateUsesBetContext(template: string) {
  return (
    template.includes("{{matchLabel}}") ||
    template.includes("{{market}}") ||
    template.includes("{{selection}}") ||
    template.includes("{{searchQuery}}")
  );
}

function normalizeTextForSelectionMatch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function selectionTextMatchesBet(candidateText: string, bet: BettingAutomationBetInput) {
  const candidate = normalizeTextForSelectionMatch(candidateText);
  // Prefer selectionHint (explicit label) over raw selection field
  const matchTarget = (bet.selectionHint?.trim() || bet.selection).trim();
  const selection = normalizeTextForSelectionMatch(matchTarget);
  if (!candidate || !selection) return false;
  if (candidate.includes(selection)) return true;
  const selectionTokens = selection.split(" ").filter((token) => token.length >= 2);
  return selectionTokens.length > 0 && selectionTokens.every((token) => candidate.includes(token));
}

export function buildSessionSummary(
  request: BettingAutomationRequest,
  confirmedBy: string | null,
): BettingAutomationSessionSummary {
  const betsToPlace = request.bets && request.bets.length > 0 ? request.bets : [request.bet];
  const isCombo = betsToPlace.length > 1;
  if (isCombo) {
    const combinedOdds = betsToPlace.reduce((acc, b) => acc * b.odds, 1);
    return {
      matchLabel: betsToPlace.map((b) => b.matchLabel).join(" + "),
      market: betsToPlace.map((b) => b.market).join(" + "),
      selection: betsToPlace.map((b) => b.selection).join(" + "),
      odds: Math.round(combinedOdds * 100) / 100,
      stake: betsToPlace[0]!.stake,
      currency: betsToPlace[0]!.currency?.trim() || "RON",
      bookmaker: request.bookmakerConfig.bookmaker,
      confirmedBy,
      bets: betsToPlace,
    };
  }
  return {
    matchLabel: request.bet.matchLabel,
    market: request.bet.market,
    selection: request.bet.selection,
    odds: request.bet.odds,
    stake: request.bet.stake,
    currency: request.bet.currency?.trim() || "RON",
    bookmaker: request.bookmakerConfig.bookmaker,
    confirmedBy,
  };
}

export function validateStakeGuards(request: BettingAutomationRequest) {
  const betsToPlace = request.bets && request.bets.length > 0 ? request.bets : [request.bet];
  const stake = betsToPlace[0]!.stake;
  if (!(stake > 0)) {
    throw unprocessable("Stake must be greater than zero.");
  }
  if (stake > request.riskControls.maxStakePerBet) {
    throw unprocessable("Stake exceeds max stake per bet.");
  }
  if (stake > request.riskControls.maxTotalStakePerSession) {
    throw unprocessable("Stake exceeds max total stake per session.");
  }
}

export function resolveBrowserName(input?: BettingAutomationExecutionOptions | null) {
  if (input?.skipLogin === true) {
    return "chromium";
  }
  return input?.browserName === "firefox" ? "firefox" : "chromium";
}

export function resolveUserDataDir(input?: BettingAutomationExecutionOptions | null) {
  if (input?.skipLogin === true) {
    return path.resolve(DEFAULT_BBA_CHROMIUM_PROFILE);
  }
  const value = input?.userDataDir?.trim();
  if (value) return path.resolve(value);
  return null;
}

function hasSecretRef(ref?: BettingAutomationSecretRef | null) {
  return Boolean(ref?.secretId?.trim() || ref?.secretName?.trim());
}

function canAttemptCredentialLogin(request: BettingAutomationRequest) {
  return (
    hasSecretRef(request.loginUsername) &&
    hasSecretRef(request.loginPassword) &&
    (request.bookmakerConfig.username?.selectors?.length ?? 0) > 0 &&
    (request.bookmakerConfig.password?.selectors?.length ?? 0) > 0 &&
    (request.bookmakerConfig.loginSubmit?.selectors?.length ?? 0) > 0
  );
}

export function resolveEntryUrl(request: BettingAutomationRequest) {
  return (
    request.execution?.startUrl?.trim() ||
    request.bookmakerConfig.postLoginUrl?.trim() ||
    request.bookmakerConfig.baseUrl.trim() ||
    request.bookmakerConfig.loginUrl.trim()
  );
}

function resolveSkipLoginVerificationUrl(request: BettingAutomationRequest) {
  return (
    request.bookmakerConfig.baseUrl.trim() ||
    request.bookmakerConfig.loginUrl.trim()
  );
}

export function shouldUseCdpPersistentProfile(request: BettingAutomationRequest) {
  const bookmaker = request.bookmakerConfig.bookmaker.trim().toLowerCase();
  return (
    request.execution?.skipLogin === true &&
    resolveBrowserName(request.execution) === "chromium" &&
    Boolean(resolveUserDataDir(request.execution)) &&
    bookmaker.includes("casa pariurilor")
  );
}

function normalizeRuntimeConfig(input?: BettingAutomationExecutionOptions | null): RuntimeConfig {
  const actionDelayMinMs = Math.max(0, input?.actionDelayMinMs ?? DEFAULT_ACTION_DELAY_MIN_MS);
  const actionDelayMaxMs = Math.max(actionDelayMinMs, input?.actionDelayMaxMs ?? DEFAULT_ACTION_DELAY_MAX_MS);
  const retryDelayMinMs = Math.max(0, input?.retryDelayMinMs ?? DEFAULT_RETRY_DELAY_MIN_MS);
  const retryDelayMaxMs = Math.max(retryDelayMinMs, input?.retryDelayMaxMs ?? DEFAULT_RETRY_DELAY_MAX_MS);

  return {
    pageTimeoutMs: Math.max(1_000, input?.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS),
    sessionTimeoutMs: Math.max(60_000, input?.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
    actionDelayMinMs,
    actionDelayMaxMs,
    retryDelayMinMs,
    retryDelayMaxMs,
    minClickIntervalMs: Math.max(0, input?.minClickIntervalMs ?? DEFAULT_MIN_CLICK_INTERVAL_MS),
    headless: input?.headless ?? false,
  };
}

function pickDelay(minMs: number, maxMs: number, random: () => number) {
  if (maxMs <= minMs) return minMs;
  return Math.round(minMs + (maxMs - minMs) * random());
}

function shouldSkipProfileCopyEntry(entryPath: string) {
  if (PROFILE_LOCK_FILE_NAMES.has(path.basename(entryPath))) {
    return true;
  }
  const pathSegments = entryPath
    .replaceAll("/", "\\")
    .split("\\")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return pathSegments.some((segment) => PROFILE_CACHE_PATH_SEGMENTS.has(segment));
}

function isSkippableProfileCopyError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "EACCES" ||
    message.includes("EBUSY") ||
    /resource busy or locked/i.test(message)
  );
}

async function copyDirBestEffort(sourceDir: string, targetDir: string) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (shouldSkipProfileCopyEntry(sourcePath)) continue;
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirBestEffort(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile()) continue;
    try {
      await fs.copyFile(sourcePath, targetPath);
    } catch (error) {
      if (!isSkippableProfileCopyError(error)) {
        throw error;
      }
    }
  }
}

async function cloneUserDataDir(userDataDir: string, random: () => number) {
  const cloneRoot = path.join(
    os.tmpdir(),
    "paperclip-bba-profile-clones",
    `${Date.now()}-${random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(path.dirname(cloneRoot), { recursive: true });
  try {
    await fs.cp(userDataDir, cloneRoot, {
      recursive: true,
      filter: (sourcePath) => !shouldSkipProfileCopyEntry(sourcePath),
      force: true,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;
    if (code === "ENOENT") {
      // Profile directory doesn't exist yet — launch with a blank profile
      await fs.mkdir(cloneRoot, { recursive: true });
    } else if (!isSkippableProfileCopyError(error)) {
      throw error;
    } else {
      await copyDirBestEffort(userDataDir, cloneRoot);
    }
  }
  // Reset exit_type so Chrome doesn't show "Restore pages?" crash recovery dialog
  const prefsPath = path.join(cloneRoot, "Default", "Preferences");
  try {
    const prefsRaw = await fs.readFile(prefsPath, "utf8");
    const prefs = JSON.parse(prefsRaw);
    if (prefs?.profile?.exit_type) prefs.profile.exit_type = "Normal";
    if (prefs?.profile?.exited_cleanly === false) prefs.profile.exited_cleanly = true;
    await fs.writeFile(prefsPath, JSON.stringify(prefs), "utf8");
  } catch { /* ignore if Preferences not found */ }

  return cloneRoot;
}

async function resolveChromiumExecutable(playwright: PlaywrightModule) {
  const candidatePaths = [
    process.env.PAPERCLIP_BBA_CHROME_PATH,
    process.env.CHROME_PATH,
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Chromium", "Application", "chrome.exe"),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      continue;
    }
  }

  const executablePath = (playwright.chromium as { executablePath?: (() => string) | undefined }).executablePath?.();
  if (typeof executablePath === "string" && executablePath.trim().length > 0) {
    return executablePath;
  }

  throw new Error("Could not resolve a Chromium executable for CDP launch.");
}

async function connectChromiumProfileOverCdp(
  playwright: PlaywrightModule,
  profileDir: string,
  runtime: RuntimeConfig,
  startUrl: string,
  random: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<LaunchedBrowserSession> {
  const executablePath = await resolveChromiumExecutable(playwright);
  const cdpPort = 40000 + Math.floor(random() * 10000);
  const chromeProcess = spawn(
    executablePath,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      "--new-window",
      "--window-size=1280,800",
      ...CHROMIUM_STEALTH_ARGS,
      startUrl,
    ],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );

  let browser: Browser | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (chromeProcess.exitCode !== null) {
      throw new Error(`Chromium exited before CDP attach (exit=${chromeProcess.exitCode}).`);
    }
    try {
      browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      break;
    } catch {
      await sleep(500);
    }
  }

  if (!browser) {
    try {
      chromeProcess.kill();
    } catch {
      // ignore
    }
    throw new Error("Timed out connecting to Chromium over CDP.");
  }

  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    try {
      chromeProcess.kill();
    } catch {
      // ignore
    }
    throw new Error("Chromium CDP session did not expose a default browser context.");
  }

  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(runtime.pageTimeoutMs);

  return {
    browser,
    context,
    page,
    mode: "cdp",
    chromeProcess,
  };
}

async function appendLog(paths: SessionPaths, message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs.appendFile(paths.logPath, line, "utf8");
}

function ensureSelectors(name: string, input?: BettingAutomationSelectorSet) {
  const selectors = input?.selectors?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (selectors.length === 0 && !input?.optional) {
    throw unprocessable(`Missing selectors for ${name}.`);
  }
}

function assertDeadline(startedAt: number, sessionTimeoutMs: number) {
  if (Date.now() - startedAt > sessionTimeoutMs) {
    throw new Error("Session timeout exceeded 20 minute guardrail.");
  }
}

async function sleepFor(
  sleep: (ms: number) => Promise<void>,
  runtime: RuntimeConfig,
  random: () => number,
) {
  await sleep(pickDelay(runtime.actionDelayMinMs, runtime.actionDelayMaxMs, random));
}

// Adjacent-key map for occasional typo simulation (QWERTY)
const ADJACENT_KEYS: Record<string, string> = {
  "1":"2","2":"13","3":"24","4":"35","5":"46","6":"57","7":"68","8":"79","9":"80","0":"9",
  q:"wa","w":"qea","e":"wrs","r":"etd","t":"ryf","y":"tug","u":"yih","i":"uoj","o":"ipk","p":"ol",
  a:"qsz","s":"awdxz","d":"sefcx","f":"drgvc","g":"ftyhb","h":"gyujn","j":"huikm","k":"jiol","l":"kop",
  z:"asx","x":"zsdc","c":"xdfv","v":"cfgb","b":"vghn","n":"bhjm","m":"njk",
};

async function typeHuman(
  page: Page,
  text: string,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
) {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    // 8% chance of a typo: type adjacent key, pause, backspace, then correct char
    const adjacents = ADJACENT_KEYS[char.toLowerCase()];
    if (adjacents && random() < 0.08) {
      const wrong = adjacents[Math.floor(random() * adjacents.length)]!;
      await page.keyboard.type(wrong);
      await sleep(180 + Math.round(random() * 420));
      await page.keyboard.press("Backspace");
      await sleep(80 + Math.round(random() * 120));
    }
    await page.keyboard.type(char);
    // Variable per-character delay: 50-180ms (non-uniform)
    const baseDelay = 50 + Math.round(random() * 130);
    // ~25% chance of a slightly longer pause (thinking mid-word)
    const extra = random() < 0.25 ? Math.round(random() * 350) : 0;
    await sleep(baseDelay + extra);
  }
}

async function idleScroll(
  page: Page,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
) {
  const scrollDown = 180 + Math.round(random() * 320);
  await page.evaluate((amt: number) => window.scrollBy({ top: amt, behavior: "smooth" }), scrollDown);
  await sleep(500 + Math.round(random() * 900));
  if (random() > 0.45) {
    await page.evaluate((amt: number) => window.scrollBy({ top: -amt, behavior: "smooth" }), Math.round(scrollDown * 0.35));
    await sleep(300 + Math.round(random() * 500));
  }
}

async function locateOne(page: Page, selectors: string[], bet: BettingAutomationBetInput) {
  for (const selector of selectors) {
    const rendered = renderSelectorTemplate(selector, bet);
    const locator = page.locator(rendered).first();
    if (await locator.count().catch(() => 0)) {
      return locator;
    }
  }
  return null;
}

export async function locateVisibleOne(page: Page, selectors: string[], bet: BettingAutomationBetInput) {
  // Search main frame first, then sub-frames (e.g. Casa Pariurilor login iframe)
  const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
  for (const frame of frames) {
    for (const selector of selectors) {
      const rendered = renderSelectorTemplate(selector, bet);
      try {
        const locator = frame.locator(rendered);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            return candidate;
          }
        }
      } catch { /* skip invalid selectors for this frame */ }
    }
  }
  return null;
}

export async function waitForVisibleOne(
  page: Page,
  selectors: string[],
  bet: BettingAutomationBetInput,
  opts: {
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  },
) {
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 250);
  while (Date.now() <= deadline) {
    const locator = await locateVisibleOne(page, selectors, bet);
    if (locator) return locator;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await opts.sleep(Math.min(pollIntervalMs, remainingMs));
  }
  return null;
}

async function hasVisibleAuthPrompt(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
) {
  const [usernameVisible, passwordVisible, submitVisible] = await Promise.all([
    config.username?.selectors?.length
      ? locateVisibleOne(page, config.username.selectors, bet).then((locator) => locator !== null)
      : Promise.resolve(false),
    config.password?.selectors?.length
      ? locateVisibleOne(page, config.password.selectors, bet).then((locator) => locator !== null)
      : Promise.resolve(false),
    config.loginSubmit?.selectors?.length
      ? locateVisibleOne(page, config.loginSubmit.selectors, bet).then((locator) => locator !== null)
      : Promise.resolve(false),
  ]);

  return submitVisible || (usernameVisible && passwordVisible);
}

function getLoginEntrySelectors(config: BettingAutomationBookmakerConfig) {
  const bookmaker = config.bookmaker.trim().toLowerCase();
  if (bookmaker.includes("casa pariurilor")) {
    return [
      ".header-login-wrapper.user-box-link",
      "#user-box-wrapper .header-login-wrapper",
      "#user-box-wrapper .user-box-link",
      "text=/^\\s*Conectare\\s*$/i",
    ];
  }
  return [
    "text=/^\\s*Log\\s*in\\s*$/i",
    "text=/^\\s*Login\\s*$/i",
    "text=/^\\s*Sign\\s*in\\s*$/i",
    "text=/^\\s*Conectare\\s*$/i",
    "[aria-label*='login' i]",
    "[aria-label*='log in' i]",
    "[aria-label*='sign in' i]",
  ];
}

// Ordered list of confirmed Casa Pariurilor overlay selectors.
// "JOACĂ ÎN CONTINUARE" first — it triggers site-side re-auth after click.
const CASA_OVERLAY_DISMISS_SELECTORS = [
  "button:has-text('JOACĂ ÎN CONTINUARE')",
  "button:has-text('ACCEPT TOATE')",
  "button:has-text('Accept toate')",
  "button:has-text('DOAR CELE NECESARE')",
  "button:has-text('Romanian')",
  "button:has-text('Română')",
  "[class*='popup'] [class*='close']",
  "[class*='modal'] [class*='close']",
  "[class*='Popup'] [class*='close']",
  "[class*='Popup'] [class*='Close']",
  "[class*='popup'] [class*='Close']",
  ".modal-close",
  "button[aria-label='Close']",
  "button[aria-label='close']",
  "button[aria-label='Inchide']",
  "[class*='promo'] button[class*='close']",
  "[class*='promo'] button[class*='Close']",
  "[data-testid*='close']",
  "[class*='CloseButton']",
  "[class*='close-button']",
  "button:has-text('Sunt major')",
  "button:has-text('Am peste 18 ani')",
];

async function dismissCasaOverlays(page: Page): Promise<void> {
  for (const sel of CASA_OVERLAY_DISMISS_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        logger.info(`bba: dismissCasaOverlays clicking: ${sel}`);
        await btn.click({ timeout: 2_000 });
        // "JOACĂ ÎN CONTINUARE" triggers site-side re-auth — give it time
        if (sel.includes("JOACĂ")) await page.waitForTimeout(2_500);
        else await page.waitForTimeout(500);
      }
    } catch { /* overlay may not be present */ }
  }
  // JS-based fallback: click any visible close/X button inside a modal/dialog/popup
  const jsClickedClose = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      "[class*='popup'] button, [class*='modal'] button, [class*='Popup'] button, [class*='Modal'] button, [role='dialog'] button"
    )).filter((el) => {
      const e = el as HTMLElement;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const txt = e.innerText?.trim().toLowerCase() ?? "";
      const cls = e.className?.toLowerCase() ?? "";
      const label = e.getAttribute("aria-label")?.toLowerCase() ?? "";
      // Only click buttons that look like close buttons, NOT login/action buttons
      return (
        txt === "×" || txt === "x" || txt === "✕" || txt === "✖" || txt === "close" ||
        cls.includes("close") || label.includes("close") || label.includes("inchide") ||
        (txt === "" && (cls.includes("btn-close") || cls.includes("icon-close")))
      );
    });
    if (candidates.length > 0) {
      (candidates[0] as HTMLElement).click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (jsClickedClose) {
    logger.info("bba: dismissCasaOverlays JS-fallback clicked close button in popup");
    await page.waitForTimeout(500);
  }
  // Escape key as final fallback to dismiss any remaining modal/dialog
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function ensureLoginFormVisible(
  page: Page,
  request: BettingAutomationRequest,
  runtime: RuntimeConfig,
  cursorPos: { x: number; y: number },
  deps: {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    lastClickAt: { value: number };
  },
) {
  const isCasa = request.bookmakerConfig.bookmaker.trim().toLowerCase().includes("casa pariurilor");
  if (isCasa) await dismissCasaOverlays(page);

  const authSelectors = [
    ...request.bookmakerConfig.username.selectors,
    ...request.bookmakerConfig.password.selectors,
    ...request.bookmakerConfig.loginSubmit.selectors,
  ];
  const authPromptVisible = await hasVisibleAuthPrompt(page, request.bookmakerConfig, request.bet);
  if (authPromptVisible) return;

  const loginEntry = await locateVisibleOne(
    page,
    getLoginEntrySelectors(request.bookmakerConfig),
    request.bet,
  );
  if (!loginEntry) {
    logger.warn(`bba: ensureLoginFormVisible — loginEntry NOT found (${getLoginEntrySelectors(request.bookmakerConfig).join(", ")})`);
    return;
  }
  logger.info("bba: ensureLoginFormVisible — loginEntry found, clicking");

  await clickHuman(page, loginEntry, cursorPos, {
    sleep: deps.sleep,
    random: deps.random,
    minClickIntervalMs: runtime.minClickIntervalMs,
    lastClickAt: deps.lastClickAt,
  });

  // Cookie banner may appear on top of the login modal after clicking CONECTARE — dismiss it
  if (isCasa) {
    await deps.sleep(800);
    await dismissCasaOverlays(page);
  }

  let visiblePrompt = await waitForVisibleOne(page, authSelectors, request.bet, {
    timeoutMs: Math.min(runtime.pageTimeoutMs, 10_000),
    sleep: deps.sleep,
  });
  if (visiblePrompt) return;

  // Some bookmaker shells expose the entrypoint but ignore coordinate clicks until the
  // element receives a direct DOM click. Retry once before giving up on auth recovery.
  await loginEntry.click().catch(() => undefined);
  if (isCasa) {
    await deps.sleep(800);
    await dismissCasaOverlays(page);
  }
  visiblePrompt = await waitForVisibleOne(page, authSelectors, request.bet, {
    timeoutMs: Math.min(runtime.pageTimeoutMs, 5_000),
    sleep: deps.sleep,
  });
  if (!visiblePrompt) {
    throw new Error("Login form did not become visible after opening the login entrypoint.");
  }
}

function getInlineUnauthenticatedSelectors(config: BettingAutomationBookmakerConfig) {
  const bookmaker = config.bookmaker.trim().toLowerCase();
  if (bookmaker.includes("casa pariurilor")) {
    return CASA_UNAUTHENTICATED_TEXT_SELECTORS;
  }
  return [];
}

function getSecondarySessionProbeUrl(config: BettingAutomationBookmakerConfig) {
  const bookmaker = config.bookmaker.trim().toLowerCase();
  if (!bookmaker.includes("casa pariurilor")) {
    return null;
  }

  const domainOrigin = new URL(config.loginUrl || config.baseUrl).origin;
  return `https://account.casapariurilor.ro/ro/user/embedded/betslips?close=1&domain=${encodeURIComponent(domainOrigin)}`;
}

async function hasVisibleInlineUnauthenticatedState(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
) {
  const selectors = getInlineUnauthenticatedSelectors(config);
  if (selectors.length === 0) return false;
  const locator = await locateVisibleOne(page, selectors, bet);
  return locator !== null;
}

async function checkSecondarySessionActive(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
  runtime: RuntimeConfig,
  paths: SessionPaths,
  deps: {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  },
) {
  const probeUrl = getSecondarySessionProbeUrl(config);
  if (!probeUrl) {
    return true;
  }

  await appendLog(paths, `probing secondary authenticated surface ${probeUrl}`);
  await gotoWithRetry(page, probeUrl, runtime, paths, deps);
  await deps.sleep(Math.min(2_000, runtime.pageTimeoutMs));

  const inlineUnauthenticatedVisible = await hasVisibleInlineUnauthenticatedState(page, config, bet);
  if (inlineUnauthenticatedVisible) {
    await appendLog(paths, "secondary authenticated surface shows inline unauthenticated state");
    return false;
  }

  const readTitle = (page as Page & { title?: () => Promise<string> }).title;
  const title = typeof readTitle === "function"
    ? (await readTitle.call(page).catch(() => "")).trim()
    : "";
  if (CASA_ACCOUNT_UNAUTHENTICATED_TITLE_PATTERN.test(title)) {
    await appendLog(paths, `secondary authenticated surface is unauthenticated via title: ${title}`);
    return false;
  }

  await appendLog(paths, `secondary authenticated surface verified${title ? ` with title: ${title}` : ""}`);
  return true;
}

async function hasVisibleActiveBetslipState(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
) {
  const selectors = [
    ...GENERIC_BETSLIP_ACTIVE_SELECTORS,
    ...(config.reviewButton?.selectors ?? []),
    ...(config.stakeInput?.selectors ?? []),
  ];
  for (const selector of selectors) {
    const locator = await locateVisibleOne(page, [selector], bet);
    if (locator) return true;
  }
  return false;
}

// After clicking a selection, confirm it actually landed in the betslip.
// Returns false if the betslip is empty or doesn't contain the selection text within timeoutMs.
async function verifySlipContainsSelection(
  page: Page,
  bet: BettingAutomationBetInput,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const SLIP_SELECTORS = [
    "[class*='betslip']",
    "[data-test*='betslip']",
    "[class*='bet-slip']",
    "[id*='betslip']",
  ];
  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  while (Date.now() < deadline) {
    for (const sel of SLIP_SELECTORS) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        const slipText = (await el.innerText().catch(() => "")).toLowerCase();
        const needle = normalizeTextForSelectionMatch(bet.selectionHint ?? bet.selection);
        if (slipText && needle && slipText.includes(needle.toLowerCase())) return true;
      }
    }
    await sleep(500);
  }
  return false;
}

async function waitForPlacementOutcome(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
  opts: {
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    authStateSupported: boolean;
  },
): Promise<"receipt" | "auth_lost" | "timeout"> {
  const receiptSelectors = config.receiptSuccess?.selectors ?? [];
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const pollIntervalMs = Math.max(50, opts.pollIntervalMs ?? 500);

  while (Date.now() <= deadline) {
    if (opts.authStateSupported) {
      const sessionStillActive = await checkSessionActive(page, config, bet, {
        timeoutMs: Math.min(pollIntervalMs, 500),
        sleep: opts.sleep,
        pollIntervalMs: 50,
      });
      if (!sessionStillActive) return "auth_lost";
    }

    if (receiptSelectors.length > 0) {
      const receipt = await locateVisibleOne(page, receiptSelectors, bet);
      if (receipt) return "receipt";
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await opts.sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return "timeout";
}

async function readSelectionCandidateText(locator: ReturnType<Page["locator"]>) {
  const parts = [
    await locator.innerText().catch(() => ""),
    await locator.getAttribute?.("aria-label").catch(() => null),
    await locator.getAttribute?.("title").catch(() => null),
    await locator.getAttribute?.("data-test").catch(() => null),
  ];
  return parts.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
}

function parseAcceptedOddsFromReviewSummary(
  reviewSummaryText: string | null,
  preferredOdds: number | null,
) {
  if (!reviewSummaryText) return null;
  const oddsNumbers = [...reviewSummaryText.matchAll(/(\d+[.,]\d+)/g)]
    .map(([, s]) => parseFloat(s!.replace(",", ".")))
    .filter((n) => Number.isFinite(n) && n >= 1.01 && n <= 100);
  if (oddsNumbers.length === 0) return null;
  if (preferredOdds == null || !Number.isFinite(preferredOdds)) {
    return oddsNumbers[0] ?? null;
  }
  return oddsNumbers.reduce((best, candidate) => {
    if (best == null) return candidate;
    return Math.abs(candidate - preferredOdds) < Math.abs(best - preferredOdds) ? candidate : best;
  }, null as number | null);
}

async function isButtonInMarketSection(button: Locator, marketHint: string): Promise<boolean> {
  const hint = marketHint
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return button.evaluate((el: Element, h: string) => {
    let node: Element | null = el.parentElement;
    for (let depth = 0; depth < 10; depth++) {
      if (!node) return false;
      const txt = (node.textContent ?? "")
        .toLowerCase()
        .normalize("NFD")
        // strip diacritics (NFD composites)
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (txt.includes(h)) return true;
      node = node.parentElement;
    }
    return false;
  }, hint).catch(() => false);
}

async function locateSelectionButtonByText(
  page: Page,
  selectors: string[],
  bet: BettingAutomationBetInput,
) {
  for (const selector of selectors) {
    const rendered = renderSelectorTemplate(selector, bet);
    const locator = page.locator(rendered);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) continue;
      const candidateText = await readSelectionCandidateText(candidate);
      if (!selectionTextMatchesBet(candidateText, bet)) continue;
      // If marketHint is set, confirm button is inside the correct market section
      if (bet.marketHint) {
        const inSection = await isButtonInMarketSection(candidate, bet.marketHint);
        if (!inSection) continue;
      }
      return candidate;
    }
  }
  return null;
}

export async function resolveSelectionButton(
  page: Page,
  selectors: string[],
  bet: BettingAutomationBetInput,
  opts: {
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  },
) {
  if (selectors.some(selectorTemplateUsesBetContext)) {
    return waitForVisibleOne(page, selectors, bet, opts);
  }

  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 250);
  while (Date.now() <= deadline) {
    const locator = await locateSelectionButtonByText(page, selectors, bet);
    if (locator) return locator;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await opts.sleep(Math.min(pollIntervalMs, remainingMs));
  }
  return null;
}

export async function waitForLoginOutcome(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
  opts: {
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  },
) {
  const successSelectors = config.loginSuccess?.selectors ?? [];
  const failureSelectors = config.loginFailure?.selectors ?? [];
  if (successSelectors.length === 0 && failureSelectors.length === 0) {
    return "unknown" as const;
  }

  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 250);
  while (Date.now() <= deadline) {
    if (failureSelectors.length > 0) {
      const failureLocator = await locateVisibleOne(page, failureSelectors, bet);
      if (failureLocator) return "failure" as const;
    }
    if (successSelectors.length > 0) {
      const successLocator = await locateVisibleOne(page, successSelectors, bet);
      if (successLocator) return "success" as const;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await opts.sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return successSelectors.length > 0 ? ("timeout" as const) : ("unknown" as const);
}

async function maybeClickOptional(
  page: Page,
  selectors: BettingAutomationSelectorSet | undefined,
  bet: BettingAutomationBetInput,
) {
  if (!selectors?.selectors?.length) return;
  const locator = await locateOne(page, selectors.selectors, bet);
  if (!locator) return;
  if (!(await locator.isVisible().catch(() => false))) return;
  await locator.click({ timeout: 5_000 }).catch(() => undefined);
}

function buildBezierPoints(startX: number, startY: number, endX: number, endY: number, random: () => number) {
  const control1X = startX + (endX - startX) * 0.33 + (random() - 0.5) * 80;
  const control1Y = startY + (endY - startY) * 0.25 + (random() - 0.5) * 80;
  const control2X = startX + (endX - startX) * 0.66 + (random() - 0.5) * 80;
  const control2Y = startY + (endY - startY) * 0.75 + (random() - 0.5) * 80;
  // Scale steps based on distance — closer targets get fewer steps
  const dist = Math.hypot(endX - startX, endY - startY);
  const steps = Math.max(12, Math.min(45, Math.round(dist / 14)));
  const points: Array<{ x: number; y: number }> = [];
  for (let step = 0; step <= steps; step += 1) {
    // Ease-in-out: accelerate from start, decelerate near target
    const tRaw = step / steps;
    const t = tRaw < 0.5
      ? 2 * tRaw * tRaw
      : 1 - Math.pow(-2 * tRaw + 2, 2) / 2;
    const mt = 1 - t;
    points.push({
      x:
        mt ** 3 * startX +
        3 * mt ** 2 * t * control1X +
        3 * mt * t ** 2 * control2X +
        t ** 3 * endX,
      y:
        mt ** 3 * startY +
        3 * mt ** 2 * t * control1Y +
        3 * mt * t ** 2 * control2Y +
        t ** 3 * endY,
    });
  }
  return points;
}

async function moveMouseHuman(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  cursorPos: { x: number; y: number },
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): Promise<{ x: number; y: number }> {
  // Start from the tracked cursor position (not a random point near the target)
  const startX = cursorPos.x;
  const startY = cursorPos.y;
  const endX = box.x + box.width * (0.3 + random() * 0.4);
  const endY = box.y + box.height * (0.3 + random() * 0.4);
  const points = buildBezierPoints(startX, startY, endX, endY, random);
  await page.mouse.move(startX, startY);
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    // Random micro-pauses during movement (28% chance per point)
    if (random() > 0.72) await sleep(35 + Math.round(random() * 70));
  }
  return { x: endX, y: endY };
}

async function clickHuman(
  page: Page,
  locator: Awaited<ReturnType<typeof locateOne>>,
  cursorPos: { x: number; y: number },
  deps: { sleep: (ms: number) => Promise<void>; random: () => number; minClickIntervalMs: number; lastClickAt: { value: number } },
) {
  if (!locator) throw new Error("Target locator missing.");
  // Enforce minimum interval between clicks
  const now = Date.now();
  const waitMs = Math.max(0, deps.lastClickAt.value + deps.minClickIntervalMs - now);
  if (waitMs > 0) await deps.sleep(waitMs);
  // Scroll element into viewport first (avoids off-screen "magic" clicks)
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await deps.sleep(150 + Math.round(deps.random() * 300));
  const box = await locator.boundingBox();
  if (box) {
    const arrived = await moveMouseHuman(page, box, cursorPos, deps.sleep, deps.random);
    cursorPos.x = arrived.x;
    cursorPos.y = arrived.y;
    // Realistic mouse press: hold down 40-100ms before releasing
    await page.mouse.down();
    await deps.sleep(40 + Math.round(deps.random() * 60));
    await page.mouse.up();
  } else {
    await locator.click();
  }
  deps.lastClickAt.value = Date.now();
  // Post-click cursor drift — simulate natural hand tremor after click
  const driftX = Math.max(0, cursorPos.x + (deps.random() - 0.5) * 12);
  const driftY = Math.max(0, cursorPos.y + (deps.random() - 0.5) * 8);
  await page.mouse.move(driftX, driftY);
  cursorPos.x = driftX;
  cursorPos.y = driftY;
}

async function gotoWithRetry(
  page: Page,
  url: string,
  runtime: RuntimeConfig,
  paths: SessionPaths,
  deps: { sleep: (ms: number) => Promise<void>; random: () => number },
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await appendLog(paths, `goto ${url} attempt ${attempt}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: runtime.pageTimeoutMs });
      return;
    } catch (err) {
      lastError = err;
      await appendLog(paths, `goto failed attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 3) break;
      await deps.sleep(pickDelay(runtime.retryDelayMinMs, runtime.retryDelayMaxMs, deps.random));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Navigation failed after retries.");
}

async function readReviewSummary(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
) {
  const locator = config.reviewSummary?.selectors?.length
    ? await waitForVisibleOne(page, config.reviewSummary.selectors, bet, {
      timeoutMs,
      sleep,
    })
    : null;
  if (!locator) return null;
  return (await locator.innerText().catch(() => null))?.trim() ?? null;
}

async function verifyHistoryListing(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
  runtime: RuntimeConfig,
  paths: SessionPaths,
  screenshots: string[],
  deps: {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  },
) {
  if (!config.historyUrl || !config.historySelection?.selectors?.length) {
    return false;
  }

  await appendLog(paths, `opening history verification URL ${config.historyUrl}`);
  await gotoWithRetry(page, config.historyUrl, runtime, paths, deps);
  await maybeClickOptional(page, config.cookieAccept, bet);
  await maybeClickOptional(page, config.popupClose, bet);

  if (config.historyReady?.selectors?.length) {
    await waitForVisibleOne(page, config.historyReady.selectors, bet, {
      timeoutMs: Math.min(runtime.pageTimeoutMs, 15_000),
      sleep: deps.sleep,
    }).catch(() => null);
  }

  const historySelection = await waitForVisibleOne(page, config.historySelection.selectors, bet, {
    timeoutMs: Math.min(runtime.pageTimeoutMs, 15_000),
    sleep: deps.sleep,
  });
  screenshots.push(await screenshot(page, paths, historySelection ? "history-verification" : "history-verification-missing"));
  await appendLog(
    paths,
    historySelection
      ? "history verification matched the placed selection"
      : "history verification did not find the placed selection",
  );
  return historySelection !== null;
}

export async function resolveStakeInput(
  page: Page,
  selectors: string[],
  bet: BettingAutomationBetInput,
  opts: {
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  },
) {
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 250);

  while (Date.now() <= deadline) {
    for (const selector of selectors) {
      const rendered = renderSelectorTemplate(selector, bet);
      const candidates = page.locator(rendered);
      const count = await candidates.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const isEditable = await candidate.isEditable?.().catch(() => false);
        if (isEditable) return candidate;

        const descendant = candidate.locator?.("input, textarea, [contenteditable='true'], [role='spinbutton']").first();
        if (!descendant) continue;
        const descendantVisible = await descendant.isVisible().catch(() => false);
        if (!descendantVisible) continue;
        const descendantEditable = await descendant.isEditable?.().catch(() => false);
        if (descendantEditable) return descendant;
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await opts.sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return null;
}

export async function checkSessionActive(
  page: Page,
  config: BettingAutomationBookmakerConfig,
  bet: BettingAutomationBetInput,
  opts?: {
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  },
): Promise<boolean> {
  const timeoutMs = Math.max(1, opts?.timeoutMs ?? 5_000);
  const sleep = opts?.sleep ?? (async () => undefined);
  const successSelectors = config.loginSuccess?.selectors ?? [];
  const failureSelectors = config.loginFailure?.selectors ?? [];
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = Math.max(10, opts?.pollIntervalMs ?? 250);

  while (Date.now() <= deadline) {
    if (failureSelectors.length > 0) {
      const failure = await locateVisibleOne(page, failureSelectors, bet);
      if (failure) return false;
    }

    const authPromptVisible = await hasVisibleAuthPrompt(page, config, bet);
    const inlineUnauthenticatedVisible = await hasVisibleInlineUnauthenticatedState(page, config, bet);
    if (inlineUnauthenticatedVisible) {
      return false;
    }
    if (successSelectors.length > 0) {
      const success = await locateVisibleOne(page, successSelectors, bet);
      if (success && !authPromptVisible) return true;
      if (authPromptVisible) return false;
    } else if (authPromptVisible) {
      return false;
    } else {
      return true;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return false;
}

async function performLogin(
  page: Page,
  request: BettingAutomationRequest,
  runtime: RuntimeConfig,
  paths: SessionPaths,
  cursorPos: { x: number; y: number },
  screenshots: string[],
  resolveSecret: (companyId: string, ref: BettingAutomationSecretRef) => Promise<string>,
  deps: {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    lastClickAt: { value: number };
  },
) {
  const username = await resolveSecret(request.companyId, request.loginUsername);
  const password = await resolveSecret(request.companyId, request.loginPassword);

  await ensureLoginFormVisible(page, request, runtime, cursorPos, deps);

  const isCasaLogin = request.bookmakerConfig.bookmaker.trim().toLowerCase().includes("casa pariurilor");
  const CASA_USERNAME_FALLBACKS = ["input[type='text']", "input[placeholder*='utilizator' i]", "input[name*='user' i]"];
  const CASA_PASSWORD_FALLBACKS = ["input[type='password']"];
  const CASA_SUBMIT_FALLBACKS = [
    "button[class*='user-box-form-button']",
    "form button[type='submit']",
    "button:has-text('CONECTARE')",
    "button:has-text('Conectare')",
    "button:has-text('Autentificare')",
    ".modal button[type='submit']",
    "[class*='login'] button[type='submit']",
  ];

  const usernameLocator =
    (await locateVisibleOne(page, request.bookmakerConfig.username.selectors, request.bet)) ??
    (isCasaLogin ? await locateVisibleOne(page, CASA_USERNAME_FALLBACKS, request.bet) : null);
  const passwordLocator =
    (await locateVisibleOne(page, request.bookmakerConfig.password.selectors, request.bet)) ??
    (isCasaLogin ? await locateVisibleOne(page, CASA_PASSWORD_FALLBACKS, request.bet) : null);
  const loginLocator =
    (await locateVisibleOne(page, request.bookmakerConfig.loginSubmit.selectors, request.bet)) ??
    (isCasaLogin ? await locateVisibleOne(page, CASA_SUBMIT_FALLBACKS, request.bet) : null);
  if (!usernameLocator || !passwordLocator || !loginLocator) {
    throw new Error("Login selectors did not resolve.");
  }

  await sleepFor(deps.sleep, runtime, deps.random);
  await usernameLocator.fill(username);
  await sleepFor(deps.sleep, runtime, deps.random);
  await passwordLocator.fill(password);
  await clickHuman(page, loginLocator, cursorPos, {
    sleep: deps.sleep,
    random: deps.random,
    minClickIntervalMs: runtime.minClickIntervalMs,
    lastClickAt: deps.lastClickAt,
  });
  screenshots.push(await screenshot(page, paths, "after-login-submit"));
  await appendLog(paths, "login submitted");

  const loginOutcome = await waitForLoginOutcome(page, request.bookmakerConfig, request.bet, {
    timeoutMs: runtime.pageTimeoutMs,
    sleep: deps.sleep,
  });
  if (loginOutcome === "failure") {
    throw new Error("Login failure indicator appeared after submit.");
  }
  if (loginOutcome === "timeout") {
    throw new Error("Login success indicator did not appear before timeout.");
  }
  if (loginOutcome === "unknown" && request.bookmakerConfig.postLoginUrl) {
    await gotoWithRetry(page, request.bookmakerConfig.postLoginUrl, runtime, paths, {
      sleep: deps.sleep,
      random: deps.random,
    });
  }
}

async function persistSessionCookies(context: BrowserContext, paths: SessionPaths) {
  try {
    const sessionState = await context.storageState();
    await fs.writeFile(COOKIE_CACHE_PATH, JSON.stringify(sessionState, null, 2), "utf8");
    await appendLog(paths, "session cookies persisted to cache");
  } catch (persistErr) {
    await appendLog(paths, `warning: failed to persist cookie cache: ${persistErr}`);
  }
}

// Re-login using credentials saved in the browser's password manager (no external secrets needed).
// Opens the login form, waits for Chrome autofill to populate fields, then clicks submit.
async function performBrowserAutofillLogin(
  page: Page,
  request: BettingAutomationRequest,
  runtime: RuntimeConfig,
  paths: SessionPaths,
  cursorPos: { x: number; y: number },
  screenshots: string[],
  deps: { sleep: (ms: number) => Promise<void>; random: () => number; lastClickAt: { value: number } },
): Promise<boolean> {
  try {
    await ensureLoginFormVisible(page, request, runtime, cursorPos, deps);
  } catch {
    await appendLog(paths, "autofill login: could not open login form");
    return false;
  }

  // Wait for Chrome password manager to autofill the fields
  await deps.sleep(1_500);

  const usernameLocator = await locateVisibleOne(page, request.bookmakerConfig.username.selectors, request.bet);
  if (!usernameLocator) {
    await appendLog(paths, "autofill login: username field not found");
    return false;
  }
  const autofillValue = await usernameLocator.inputValue().catch(() => "");
  if (!autofillValue.trim()) {
    await appendLog(paths, "autofill login: username field empty — no browser-saved credentials");
    return false;
  }

  const isCasaAutofill = request.bookmakerConfig.bookmaker.trim().toLowerCase().includes("casa pariurilor");
  const CASA_AUTOFILL_SUBMIT_FALLBACKS = [
    "button[class*='user-box-form-button']",
    "form button[type='submit']",
    "button:has-text('CONECTARE')",
    "button:has-text('Conectare')",
    ".modal button[type='submit']",
  ];
  const loginLocator =
    (await locateVisibleOne(page, request.bookmakerConfig.loginSubmit.selectors, request.bet)) ??
    (isCasaAutofill ? await locateVisibleOne(page, CASA_AUTOFILL_SUBMIT_FALLBACKS, request.bet) : null);
  if (!loginLocator) {
    await appendLog(paths, "autofill login: submit button not found");
    return false;
  }

  await clickHuman(page, loginLocator, cursorPos, { ...deps, minClickIntervalMs: runtime.minClickIntervalMs });
  screenshots.push(await screenshot(page, paths, "autofill-login-submit"));
  await appendLog(paths, "autofill login submitted");

  const loginOutcome = await waitForLoginOutcome(page, request.bookmakerConfig, request.bet, {
    timeoutMs: runtime.pageTimeoutMs,
    sleep: deps.sleep,
  });
  if (loginOutcome === "failure") {
    await appendLog(paths, "autofill login: failure indicator appeared");
    return false;
  }
  if (loginOutcome === "unknown" && request.bookmakerConfig.postLoginUrl) {
    await gotoWithRetry(page, request.bookmakerConfig.postLoginUrl, runtime, paths, deps);
  }
  return true;
}

async function waitForOddsReady(
  page: Page,
  paths: SessionPaths,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  // Wait for SPA to finish loading odds: at least 1 odds button visible, loading indicator gone.
  // Strategy: poll every 500ms up to timeoutMs. If still loading after half timeout, reload once.
  const oddsSelectors = [
    "button.odds-button.f-button-reset-styles",
    ".odds-button",
    "button[class*='odds']",
  ];
  const loadingSelectors = [
    ".f-loading",
    "[class*='loading-offer']",
    "[class*='match-loading']",
  ];
  const deadline = Date.now() + Math.min(timeoutMs, 25_000);
  let reloaded = false;

  while (Date.now() < deadline) {
    // Check if any odds button is visible
    for (const sel of oddsSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) return; // odds ready
    }
    // After half the timeout with no odds, try a reload once
    if (!reloaded && Date.now() > deadline - Math.min(timeoutMs, 25_000) / 2) {
      await appendLog(paths, "odds not yet visible — reloading page once to re-trigger SPA fetch");
      await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
      await sleep(3000);
      reloaded = true;
    } else {
      await sleep(500);
    }
  }
  // Log what we see before giving up
  const loadingVisible = await Promise.any(
    loadingSelectors.map((s) => page.locator(s).first().isVisible().then((v) => v ? s : Promise.reject("not visible"))),
  ).catch(() => null);
  if (loadingVisible) {
    await appendLog(paths, `odds wait timed out — loading indicator still visible: ${loadingVisible}`);
  } else {
    await appendLog(paths, "odds wait timed out — no loading indicator but no odds buttons found either");
  }
}

async function verifyEventPageTeams(
  page: Page,
  bet: BettingAutomationBetInput,
  paths: SessionPaths,
): Promise<void> {
  if (!bet.matchLabel) return;
  const teams = bet.matchLabel.split(/\s*[-–vs.]+\s*/i).map(t => t.trim()).filter(Boolean);
  if (teams.length < 2) return;

  const headerText = await page.locator("h1, [class*='event-header'], [class*='match-header'], [class*='teams']")
    .first().innerText().catch(() => "");
  const normalized = normalizeTextForSelectionMatch(headerText);
  const team1Found = normalized.includes(normalizeTextForSelectionMatch(teams[0]!));
  const team2Found = normalized.includes(normalizeTextForSelectionMatch(teams[1]!));

  if (team1Found && team2Found) {
    await appendLog(paths, `event confidence: high — both teams matched in page header`);
  } else if (team1Found || team2Found) {
    await appendLog(paths, `event confidence: low — only one team found in header ("${headerText.slice(0, 80)}")`);
  } else {
    await appendLog(paths, `event confidence: unknown — neither team found in header ("${headerText.slice(0, 80)}")`);
  }
}

async function navigateToEventPage(
  page: Page,
  request: BettingAutomationRequest,
  runtime: RuntimeConfig,
  paths: SessionPaths,
  screenshots: string[],
  cursorPos: { x: number; y: number },
  deps: {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    minClickIntervalMs: number;
    lastClickAt: { value: number };
  },
) {
  if (request.bet.eventUrl) {
    await gotoWithRetry(page, request.bet.eventUrl, runtime, paths, deps);
    // Wait for SPA to render odds — Vue fetches odds asynchronously after DOM load
    await waitForOddsReady(page, paths, runtime.pageTimeoutMs, deps.sleep);
    await verifyEventPageTeams(page, request.bet, paths);
    return;
  }

  if (request.bookmakerConfig.searchInput?.selectors?.length) {
    // Ensure we are on the correct SPA base page before searching.
    // If current URL doesn't match baseUrl, navigate there first.
    const currentUrl = page.url();
    const expectedBase = request.bookmakerConfig.baseUrl.trim();
    if (!currentUrl.startsWith(expectedBase) && !currentUrl.includes("/pariuri-online/fotbal")) {
      await appendLog(paths, `navigating to baseUrl for search context: ${expectedBase}`);
      await gotoWithRetry(page, expectedBase, runtime, paths, deps);
      await deps.sleep(2000);
    }

    // If the search input is inside a modal, it may not be visible until a trigger is clicked.
    // Try to auto-discover and click the search trigger (icon/button in the nav bar).
    let searchInput = await locateOne(page, request.bookmakerConfig.searchInput.selectors, request.bet);
    if (!searchInput || !await searchInput.isVisible().catch(() => false)) {
      await appendLog(paths, "search input not immediately visible — trying to auto-open search modal");
      // Strict priority: Casa Pariurilor verified triggers first, generic fallbacks last
      const AUTO_TRIGGER_SELS = [
        '#sub-nav-search-icon',           // Casa Pariurilor /fotbal SPA — verified
        'i.icon-search',                  // Casa Pariurilor alternate icon
        '[class*="search-icon"]:not([class*="holder"]):not([class*="wrapper"])',
        '[data-testing-selector*="search" i]',
        '[aria-label*="earch" i]',
        '[aria-label*="autare" i]',
        '[title*="autare" i]',
        '[title*="earch" i]',
        'button[class*="search"]',
        'a[class*="search"]',
        '[class*="header"] [class*="search"]',
        // Generic nav search — last resort, may open wrong search UI
        '[class*="nav"] [class*="search"]',
      ];
      for (const sel of AUTO_TRIGGER_SELS) {
        const trigger = page.locator(sel).first();
        if (!await trigger.isVisible().catch(() => false)) continue;
        await trigger.click().catch(() => {});
        await deps.sleep(1200);
        const revealed = await locateOne(page, request.bookmakerConfig.searchInput.selectors, request.bet);
        if (revealed && await revealed.isVisible().catch(() => false)) {
          searchInput = revealed;
          await appendLog(paths, `search modal opened via auto-trigger: ${sel}`);
          break;
        }
        // This trigger didn't reveal the right input — undo any state change and try next
        await deps.sleep(300);
      }
    }
    if (!searchInput || !await searchInput.isVisible().catch(() => false)) {
      const waited = await waitForVisibleOne(
        page,
        request.bookmakerConfig.searchInput.selectors,
        request.bet,
        { timeoutMs: Math.min(runtime.pageTimeoutMs, 8_000), sleep: deps.sleep },
      );
      if (!waited) throw new Error("Search input not found.");
      searchInput = waited;
    }
    await sleepFor(deps.sleep, runtime, deps.random);
    // Natural focus + clear via triple-click, then type with human delays
    await searchInput.click({ clickCount: 3 });
    await deps.sleep(80 + Math.round(deps.random() * 120));
    await typeHuman(page, request.bet.searchQuery ?? request.bet.matchLabel, deps.sleep, deps.random);
    screenshots.push(await screenshot(page, paths, "search-typed"));

    const searchSubmit = request.bookmakerConfig.searchSubmit?.selectors?.length
      ? await locateOne(page, request.bookmakerConfig.searchSubmit.selectors, request.bet)
      : null;
    if (searchSubmit) {
      await clickHuman(page, searchSubmit, cursorPos, deps);
    } else {
      await page.keyboard.press("Enter");
    }
    await appendLog(paths, `search submitted for: ${request.bet.searchQuery ?? request.bet.matchLabel}`);

    // Wait for search results — they load asynchronously after submit
    const searchResult = request.bookmakerConfig.searchResult?.selectors?.length
      ? await waitForVisibleOne(
          page,
          request.bookmakerConfig.searchResult.selectors,
          request.bet,
          { timeoutMs: runtime.pageTimeoutMs, sleep: deps.sleep },
        )
      : null;
    if (!searchResult) throw new Error("Search result not found.");
    screenshots.push(await screenshot(page, paths, "search-results"));
    await sleepFor(deps.sleep, runtime, deps.random);
    await clickHuman(page, searchResult, cursorPos, deps);
    // Wait for SPA router to navigate to event page
    await Promise.race([
      page.waitForURL(/pariuri-online\/fotbal\/.+/, { timeout: runtime.pageTimeoutMs }),
      deps.sleep(4000),
    ]).catch(() => {});
    // Wait for SPA to fetch and render odds after navigation
    await waitForOddsReady(page, paths, runtime.pageTimeoutMs, deps.sleep);
    await verifyEventPageTeams(page, request.bet, paths);
    return;
  }

  if (request.execution?.startUrl?.trim()) {
    await appendLog(paths, "no event navigation configured; using startUrl page as event page");
    return;
  }

  throw new Error("No eventUrl, searchable flow, or startUrl event page configured.");
}

async function screenshot(page: Page, paths: SessionPaths, label: string) {
  const filePath = path.join(paths.screenshotsDir, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

export function bettingBrowserAutomationService(db: Db, deps: ServiceDeps) {
  const stopLoss = bettingStopLossService(db);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  async function createSessionPaths(companyId: string, issueId?: string | null, label?: string | null): Promise<{ sessionId: string; paths: SessionPaths }> {
    const sessionId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${random().toString(36).slice(2, 8)}`;
    const root = path.join(
      resolvePaperclipInstanceRoot(),
      "data",
      "betting-browser-automation",
      companyId,
      issueId?.trim() || "_no_issue",
      label?.trim() || sessionId,
    );
    const screenshotsDir = path.join(root, "screenshots");
    const videoDir = path.join(root, "videos");
    await fs.mkdir(screenshotsDir, { recursive: true });
    await fs.mkdir(videoDir, { recursive: true });
    const paths = {
      root,
      screenshotsDir,
      videoDir,
      logPath: path.join(root, "session.log"),
    };
    await fs.writeFile(paths.logPath, "", "utf8");
    return { sessionId, paths };
  }

  function generateIdempotencyKey(request: BettingAutomationRequest): string {
    const day = new Date().toISOString().slice(0, 10);
    const parts = [
      request.bookmakerConfig.bookmaker.toLowerCase().trim(),
      request.bet.matchLabel.toLowerCase().trim(),
      request.bet.market.toLowerCase().trim(),
      request.bet.selection.toLowerCase().trim(),
      String(request.bet.stake),
      day,
      request.issueId ?? "",
    ];
    return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  }

  async function persistPlacedBet(
    request: BettingAutomationRequest,
    placement: {
      executionStatus: BettingAutomationExecutionStatus;
      sessionId: string;
      paths: SessionPaths;
      reviewSummaryText: string | null;
      matchedSelection: string | null;
      acceptedOdds: number | null;
      placedAt: Date;
    },
  ) {
    const currentBalanceBefore = request.currentBalance ?? null;
    const currentBalanceAfter =
      currentBalanceBefore == null ? null : currentBalanceBefore - request.bet.stake;
    const executionLedger: BettingAutomationExecutionLedger = {
      issueId: request.issueId?.trim() || null,
      sessionId: placement.sessionId,
      artifactDir: placement.paths.root,
      logPath: placement.paths.logPath,
      bookmaker: request.bookmakerConfig.bookmaker,
      matchLabel: request.bet.matchLabel,
      market: request.bet.market,
      intendedSelection: request.bet.selection,
      selectionHint: request.bet.selectionHint?.trim() || null,
      matchedSelection: placement.matchedSelection,
      eventUrl: request.bet.eventUrl?.trim() || null,
      stake: request.bet.stake,
      currency: request.bet.currency?.trim() || "RON",
      requestedOdds: request.bet.odds,
      approvedOdds: request.execution?.finalConfirmation?.approvedOdds ?? null,
      acceptedOdds: placement.acceptedOdds,
      reviewSummaryText: placement.reviewSummaryText,
      currentBalanceBefore,
      currentBalanceAfter,
      executionStatus: placement.executionStatus,
      placedAt: placement.placedAt.toISOString(),
      confirmedBy: request.execution?.finalConfirmation?.confirmedBy?.trim() || null,
    };
    const inserted = await db.insert(bettingPlacedBets).values({
      companyId: request.companyId,
      predictionId: request.bet.predictionId ?? null,
      bookmaker: request.bookmakerConfig.bookmaker,
      odds: request.bet.odds,
      stake: request.bet.stake,
      currency: request.bet.currency?.trim() || "RON",
      idempotencyKey: generateIdempotencyKey(request),
      status: "pending",
      executionStatus: placement.executionStatus,
      executionLedger,
      notes:
        `Placed via Playwright BBA automation on ${placement.placedAt.toISOString()}. ` +
        `Execution status: ${placement.executionStatus}.`,
    }).returning();
    return inserted[0]?.id ?? null;
  }

  return {
    execute: async (request: BettingAutomationRequest): Promise<BettingAutomationResult> => {
      validateStakeGuards(request);
      const skipLogin = request.execution?.skipLogin === true;
      const userDataDir = resolveUserDataDir(request.execution);
      const canCredentialLogin = canAttemptCredentialLogin(request);
      if (!skipLogin || canCredentialLogin) {
        ensureSelectors("username", request.bookmakerConfig.username);
        ensureSelectors("password", request.bookmakerConfig.password);
        ensureSelectors("loginSubmit", request.bookmakerConfig.loginSubmit);
      }
      ensureSelectors("selectionButton", request.bookmakerConfig.selectionButton);
      ensureSelectors("stakeInput", request.bookmakerConfig.stakeInput);
      ensureSelectors("reviewButton", request.bookmakerConfig.reviewButton);

      // Idempotency: check if this exact bet was already placed today
      const idempotencyKey = generateIdempotencyKey(request);
      const existingBet = await db.select().from(bettingPlacedBets)
        .where(eq(bettingPlacedBets.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existingBet.length > 0 && existingBet[0]!.executionStatus !== "pending") {
        const eb = existingBet[0]!;
        logger.info({ idempotencyKey, placedBetId: eb.id }, "bba: duplicate request — bet already placed, returning existing record");
        const dedupSummary = buildSessionSummary(request, null);
        const dedupRisk = await stopLoss.preflight({ companyId: request.companyId });
        return {
          status: "completed",
          sessionId: (eb.executionLedger as Record<string, unknown>)?.sessionId as string ?? "dedup",
          summary: dedupSummary,
          artifactDir: (eb.executionLedger as Record<string, unknown>)?.artifactDir as string ?? "",
          logPath: (eb.executionLedger as Record<string, unknown>)?.logPath as string ?? "",
          screenshots: [],
          videoDir: (eb.executionLedger as Record<string, unknown>)?.artifactDir as string ?? "",
          reviewSummaryText: null,
          placedBetId: eb.id,
          risk: dedupRisk,
          failureReason: null,
        };
      }

      const runtime = normalizeRuntimeConfig(request.execution);
      const startedAt = Date.now();
      const { sessionId, paths } = await createSessionPaths(
        request.companyId,
        request.issueId,
        request.execution?.sessionLabel ?? null,
      );
      const lastClickAt = { value: 0 };
      const summary = buildSessionSummary(
        request,
        request.execution?.finalConfirmation?.confirmedBy?.trim() || null,
      );

      const risk = await stopLoss.preflight({
        companyId: request.companyId,
        currentBalance: request.currentBalance ?? null,
        sessionStartedAt: request.sessionStartedAt ?? null,
        dailyLimitPct: request.riskControls.dailyStopLossPct,
        sessionLimitPct: request.riskControls.sessionStopLossPct,
        source: "betting_browser_automation",
      });

      if (!risk.allowed) {
        await appendLog(paths, `risk blocked: ${risk.reason ?? "unknown"}`);
        return {
          status: "blocked_by_risk",
          sessionId,
          summary,
          artifactDir: paths.root,
          logPath: paths.logPath,
          screenshots: [],
          videoDir: paths.videoDir,
          reviewSummaryText: null,
          placedBetId: null,
          risk,
          failureReason: risk.reason ?? "Risk controls blocked execution.",
        };
      }

      const playwright = deps.playwright ?? await import("@playwright/test");
      const browserName = resolveBrowserName(request.execution);
      const browserType = browserName === "firefox" ? playwright.firefox : playwright.chromium;
      const screenshots: string[] = [];
      let page: Page | null = null;
      let context: BrowserContext | null = null;
      let browser: Browser | null = null;
      let clonedUserDataDir: string | null = null;
      let chromeProcess: ReturnType<typeof spawn> | null = null;

      try {
        const viewport = COMMON_VIEWPORTS[Math.floor(random() * COMMON_VIEWPORTS.length)]!;
        const isChromium = browserName === "chromium";
        const contextOptions = {
          headless: runtime.headless,
          viewport,
          locale: "ro-RO",
          timezoneId: "Europe/Bucharest",
          recordVideo: { dir: paths.videoDir, size: { width: 1280, height: 720 } },
          ...(isChromium ? { args: CHROMIUM_STEALTH_ARGS } : {}),
        };
        if (userDataDir) {
          clonedUserDataDir = await cloneUserDataDir(userDataDir, random);
          await appendLog(
            paths,
            `persistent profile cloned from ${userDataDir} to ${clonedUserDataDir}`,
          );
          const canConnectOverCdp = typeof (playwright.chromium as { connectOverCDP?: unknown }).connectOverCDP === "function";
          if (shouldUseCdpPersistentProfile(request) && canConnectOverCdp) {
            const launched = await connectChromiumProfileOverCdp(
              playwright,
              clonedUserDataDir,
              runtime,
              resolveSkipLoginVerificationUrl(request),
              random,
              sleep,
            );
            browser = launched.browser;
            context = launched.context;
            page = launched.page;
            chromeProcess = launched.chromeProcess;
            await appendLog(paths, "persistent profile launched over CDP to avoid Playwright pipe detection");
          } else {
            context = await browserType.launchPersistentContext(clonedUserDataDir, contextOptions);
          }
        } else {
          browser = await browserType.launch({
            headless: runtime.headless,
            slowMo: 0,
            ...(isChromium ? { args: CHROMIUM_STEALTH_ARGS } : {}),
          });
          context = await browser.newContext({
            viewport,
            locale: "ro-RO",
            timezoneId: "Europe/Bucharest",
            recordVideo: { dir: paths.videoDir, size: { width: 1280, height: 720 } },
          });
        }
        // Patch navigator to remove automation signals on every page
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
          // @ts-ignore
          window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
          Object.defineProperty(navigator, "languages", { get: () => ["ro-RO", "ro", "en-US", "en"] });
          // Non-empty plugins list (headless has 0 by default)
          Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
        });
        page = page ?? context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(runtime.pageTimeoutMs);

        // Auto-dismiss Casa Pariurilor session/activity popups via addLocatorHandler.
        // Handles two confirmed popups:
        //   1. "Continuă" — 60-min inactivity notification
        //   2. "JOACĂ ÎN CONTINUARE" — session expiry; site triggers its own auto-reauth after click
        if (request.bookmakerConfig.bookmaker.trim().toLowerCase().includes("casa pariurilor")) {
          const activePage = page!;
          const casaActivityBtn = activePage.locator(
            "button:has-text('Continuă'), button:has-text('Continua'), button:has-text('JOACĂ ÎN CONTINUARE')",
          );
          await activePage.addLocatorHandler(casaActivityBtn, async () => {
            await casaActivityBtn.first().click({ timeout: 3_000 }).catch(() => undefined);
            // "JOACĂ ÎN CONTINUARE" triggers site-side re-auth — wait for it to complete
            await activePage.waitForTimeout(2_500);
            await appendLog(paths, "dismissed Casa session/activity popup — site re-auth may have triggered");
          });
        }

        // Initial cursor position: somewhere plausible on screen
        const cursorPos = { x: Math.round(200 + random() * 600), y: Math.round(200 + random() * 300) };

        await appendLog(paths, `session started for ${request.bet.matchLabel}`);
        await appendLog(paths, `browser launched: ${browserName}`);
        if (userDataDir) {
          await appendLog(paths, `persistent profile enabled: ${userDataDir}`);
        }
        if (skipLogin) {
          // Inject any cookies persisted from a prior automatic re-login
          try {
            const cached = JSON.parse(await fs.readFile(COOKIE_CACHE_PATH, "utf8"));
            if (Array.isArray(cached?.cookies) && cached.cookies.length > 0) {
              await context.addCookies(cached.cookies);
              await appendLog(paths, `loaded ${cached.cookies.length} cached session cookies`);
            }
          } catch {
            // no cookie cache yet — first run or file missing
          }
          // Warm-up: use the configured sportsbook shell, not just the domain origin.
          // Casa Pariurilor rejects or degrades the root-domain hop, while the /pariuri-online/fotbal
          // SPA is the verified entry point for authenticated sportsbook automation.
          const warmUpUrl = resolveSkipLoginVerificationUrl(request);
          const requiresWarmUp = resolveEntryUrl(request) !== warmUpUrl;
          if (requiresWarmUp) {
            await appendLog(paths, `warm-up: navigating to ${warmUpUrl} before event page`);
            await page.goto(warmUpUrl, { waitUntil: "domcontentloaded", timeout: runtime.pageTimeoutMs });
            await sleep(pickDelay(2000, 3000, random));
          }
          await appendLog(paths, `persistent profile mode; verifying authentication at ${warmUpUrl}`);
          if (!requiresWarmUp) {
            await gotoWithRetry(page, warmUpUrl, runtime, paths, { sleep, random });
          }
          assertDeadline(startedAt, runtime.sessionTimeoutMs);
          await maybeClickOptional(page, request.bookmakerConfig.cookieAccept, request.bet);
          await maybeClickOptional(page, request.bookmakerConfig.popupClose, request.bet);

          const sessionActive = await checkSessionActive(page, request.bookmakerConfig, request.bet, {
            timeoutMs: Math.min(runtime.pageTimeoutMs, 10_000),
            sleep,
          });
          const secondarySessionActive = sessionActive
            ? await checkSecondarySessionActive(
              page,
              request.bookmakerConfig,
              request.bet,
              runtime,
              paths,
              { sleep, random },
            )
            : false;
          if (sessionActive && secondarySessionActive) {
            await appendLog(paths, "existing authenticated session verified");
            screenshots.push(await screenshot(page, paths, "session-authenticated"));
          } else {
            screenshots.push(await screenshot(page, paths, "session-not-authenticated"));
            await appendLog(
              paths,
              sessionActive
                ? "persistent profile has shell auth but missing secondary account auth"
                : "persistent profile is not authenticated at session start",
            );

            if (!canCredentialLogin) {
              // No external secrets — try logging in via browser-saved credentials (Chrome autofill)
              await appendLog(paths, "no credential secrets — attempting browser autofill login");
              const autofillOk = await performBrowserAutofillLogin(
                page, request, runtime, paths, cursorPos, screenshots, { sleep, random, lastClickAt },
              );
              if (!autofillOk) {
                return {
                  status: "session_expired",
                  sessionId,
                  summary,
                  artifactDir: paths.root,
                  logPath: paths.logPath,
                  screenshots,
                  videoDir: paths.videoDir,
                  reviewSummaryText: null,
                  placedBetId: null,
                  risk,
                  failureReason:
                    "Persistent session is not authenticated and browser autofill login failed — no saved credentials or login form not accessible.",
                };
              }
            } else {
              await appendLog(paths, "credentials available — attempting login for this browser session");
              await gotoWithRetry(page, request.bookmakerConfig.loginUrl, runtime, paths, { sleep, random });
              assertDeadline(startedAt, runtime.sessionTimeoutMs);
              await maybeClickOptional(page, request.bookmakerConfig.cookieAccept, request.bet);
              await maybeClickOptional(page, request.bookmakerConfig.popupClose, request.bet);
              await performLogin(page, request, runtime, paths, cursorPos, screenshots, deps.resolveSecret, {
                sleep, random, lastClickAt,
              });
            }

            const reloggedSessionActive = await checkSessionActive(page, request.bookmakerConfig, request.bet, {
              timeoutMs: Math.min(runtime.pageTimeoutMs, 10_000),
              sleep,
            });
            const reloggedSecondarySessionActive = reloggedSessionActive
              ? await checkSecondarySessionActive(
                page,
                request.bookmakerConfig,
                request.bet,
                runtime,
                paths,
                { sleep, random },
              )
              : false;
            if (!reloggedSessionActive || !reloggedSecondarySessionActive) {
              screenshots.push(await screenshot(page, paths, "login-verification-failed"));
              throw new Error("Login completed but the authenticated sportsbook/account session could not be verified.");
            }
            screenshots.push(await screenshot(page, paths, "session-authenticated"));
            await persistSessionCookies(context, paths);
          }

          await appendLog(paths, `opening post-auth entry URL ${resolveEntryUrl(request)}`);
          await gotoWithRetry(page, resolveEntryUrl(request), runtime, paths, { sleep, random });
          assertDeadline(startedAt, runtime.sessionTimeoutMs);

          const postEntrySessionActive = await checkSessionActive(page, request.bookmakerConfig, request.bet, {
            timeoutMs: Math.min(runtime.pageTimeoutMs, 5_000),
            sleep,
          });
          if (!postEntrySessionActive) {
            screenshots.push(await screenshot(page, paths, "entry-url-auth-failed"));
            throw new Error("Authentication could not be verified after navigating to the betting page.");
          }
          screenshots.push(await screenshot(page, paths, "entry-url-authenticated"));
        } else {
          await gotoWithRetry(page, request.bookmakerConfig.loginUrl, runtime, paths, { sleep, random });
          assertDeadline(startedAt, runtime.sessionTimeoutMs);
          await maybeClickOptional(page, request.bookmakerConfig.cookieAccept, request.bet);
          await maybeClickOptional(page, request.bookmakerConfig.popupClose, request.bet);
          await performLogin(page, request, runtime, paths, cursorPos, screenshots, deps.resolveSecret, {
            sleep, random, lastClickAt,
          });
          const sessionActive = await checkSessionActive(page, request.bookmakerConfig, request.bet, {
            timeoutMs: Math.min(runtime.pageTimeoutMs, 10_000),
            sleep,
          });
          if (!sessionActive) {
            screenshots.push(await screenshot(page, paths, "login-verification-failed"));
            throw new Error("Login completed but the authenticated session could not be verified.");
          }
          screenshots.push(await screenshot(page, paths, "session-authenticated"));
          await persistSessionCookies(context, paths);
        }

        const betsToPlace = request.bets && request.bets.length > 0 ? request.bets : [request.bet];
        const matchedSelections: string[] = [];
        const navDeps = { sleep, random, minClickIntervalMs: runtime.minClickIntervalMs, lastClickAt };

        assertDeadline(startedAt, runtime.sessionTimeoutMs);
        await maybeClickOptional(page, request.bookmakerConfig.cookieAccept, betsToPlace[0]!);
        await maybeClickOptional(page, request.bookmakerConfig.popupClose, betsToPlace[0]!);

        for (let i = 0; i < betsToPlace.length; i++) {
          const currentBet = betsToPlace[i]!;
          await navigateToEventPage(page, { ...request, bet: currentBet }, runtime, paths, screenshots, cursorPos, navDeps);
          screenshots.push(await screenshot(page, paths, `event-page-${i + 1}`));
          assertDeadline(startedAt, runtime.sessionTimeoutMs);
          await idleScroll(page, sleep, random);

          if (request.bookmakerConfig.marketGroup?.selectors?.length) {
            const marketGroup = await locateOne(page, request.bookmakerConfig.marketGroup.selectors, currentBet);
            if (marketGroup) {
              await sleepFor(sleep, runtime, random);
              await clickHuman(page, marketGroup, cursorPos, navDeps);
            }
          }

          const selectionButton = await resolveSelectionButton(
            page,
            request.bookmakerConfig.selectionButton.selectors,
            currentBet,
            { timeoutMs: runtime.pageTimeoutMs, sleep },
          );
          if (!selectionButton) throw new Error(`Bet selection button not found for leg ${i + 1}: ${currentBet.matchLabel}`);
          await sleepFor(sleep, runtime, random);
          matchedSelections.push((await readSelectionCandidateText(selectionButton)).trim());
          await clickHuman(page, selectionButton, cursorPos, navDeps);
          screenshots.push(await screenshot(page, paths, `selection-${i + 1}-picked`));

          const slipOk = await verifySlipContainsSelection(page, currentBet, runtime.pageTimeoutMs, sleep);
          if (!slipOk) {
            await appendLog(paths, `slip verification failed for leg ${i + 1}: selection not found in betslip`);
            screenshots.push(await screenshot(page, paths, `slip-verify-failed-${i + 1}`));
            throw new Error(`Slip verification failed for leg ${i + 1}: selection did not appear in betslip after click.`);
          }
          await appendLog(paths, `slip verified: leg ${i + 1} selection confirmed in betslip`);

          // Brief pause between legs so betslip can register each selection
          if (i < betsToPlace.length - 1) {
            await sleep(pickDelay(1500, 2500, random));
          }
        }

        const primaryBet = betsToPlace[0]!;

        const stakeInput = await resolveStakeInput(
          page,
          request.bookmakerConfig.stakeInput.selectors,
          primaryBet,
          { timeoutMs: runtime.pageTimeoutMs, sleep },
        );
        if (!stakeInput) throw new Error("Stake input not found.");
        await sleepFor(sleep, runtime, random);
        // Natural clear: triple-click to select all (instead of programmatic fill(""))
        await stakeInput.click({ clickCount: 3 });
        await sleep(80 + Math.round(random() * 120));
        await typeHuman(page, String(primaryBet.stake), sleep, random);

        // Verify the stake landed correctly in the input
        const typedValue = await stakeInput.inputValue().catch(() => "");
        const typedNum = parseFloat(typedValue.replace(",", "."));
        if (!isNaN(typedNum) && Math.abs(typedNum - primaryBet.stake) > 0.01) {
          await appendLog(paths, `stake mismatch: typed="${typedValue}" expected=${primaryBet.stake}`);
          screenshots.push(await screenshot(page, paths, "stake-mismatch"));
          throw new Error(`Stake mismatch: typed "${typedValue}", expected ${primaryBet.stake}.`);
        }

        const reviewSummaryText = await readReviewSummary(
          page,
          request.bookmakerConfig,
          primaryBet,
          sleep,
          Math.min(runtime.pageTimeoutMs, 5_000),
        );
        screenshots.push(await screenshot(page, paths, "review-stage"));
        await appendLog(paths, `review ready: ${reviewSummaryText ?? "no summary element configured"}`);
        const acceptedOdds = parseAcceptedOddsFromReviewSummary(
          reviewSummaryText,
          request.execution?.finalConfirmation?.approvedOdds ?? primaryBet.odds,
        );

        // Odds-drift guard: in Call 2 (post-approval), verify odds haven't moved beyond tolerance
        const approvedOdds = request.execution?.finalConfirmation?.approvedOdds;
        if (approvedOdds && approvedOdds > 0 && reviewSummaryText) {
          const driftTolerancePct = request.execution?.finalConfirmation?.oddsDriftTolerancePct ?? 5;
          const detectedOdds = acceptedOdds;
          if (detectedOdds != null) {
            const driftPct = (Math.abs(detectedOdds - approvedOdds) / approvedOdds) * 100;
            await appendLog(paths, `odds drift check: approved=${approvedOdds} current=${detectedOdds} drift=${driftPct.toFixed(1)}%`);
            if (driftPct > driftTolerancePct) {
              screenshots.push(await screenshot(page, paths, "odds-drift"));
              return {
                status: "failed",
                sessionId,
                summary,
                artifactDir: paths.root,
                logPath: paths.logPath,
                screenshots,
                videoDir: paths.videoDir,
                reviewSummaryText,
                placedBetId: null,
                risk,
                failureReason: `Odds drifted ${driftPct.toFixed(1)}% from approved ${approvedOdds} → current ${detectedOdds}. Tolerance is ${driftTolerancePct}%. Bet not placed — manual review required.`,
              };
            }
          } else {
            await appendLog(paths, `odds drift check: could not parse current odds from betslip; proceeding`);
          }
        }

        const confirmationRequired = request.riskControls.requireFinalConfirmation !== false;
        const confirmed = request.execution?.finalConfirmation?.confirmed === true;
        if (confirmationRequired && !confirmed) {
          await appendLog(paths, "awaiting final confirmation before submit");
          return {
            status: "awaiting_confirmation",
            sessionId,
            summary,
            artifactDir: paths.root,
            logPath: paths.logPath,
            screenshots,
            videoDir: paths.videoDir,
            reviewSummaryText,
            placedBetId: null,
            risk,
            failureReason: null,
          };
        }

        const reviewButton = await waitForVisibleOne(page, request.bookmakerConfig.reviewButton.selectors, primaryBet, { timeoutMs: runtime.pageTimeoutMs, sleep });
        if (!reviewButton) throw new Error("Review button not found.");
        await sleepFor(sleep, runtime, random);
        await clickHuman(page, reviewButton, cursorPos, { sleep, random, minClickIntervalMs: runtime.minClickIntervalMs, lastClickAt });

        if (request.bookmakerConfig.submitButton?.selectors?.length) {
          // Two-step flow: reviewButton opens a confirmation dialog, submitButton confirms
          screenshots.push(await screenshot(page, paths, "after-review-click"));
          const submitButton = await waitForVisibleOne(page, request.bookmakerConfig.submitButton.selectors, primaryBet, { timeoutMs: runtime.pageTimeoutMs, sleep });
          if (!submitButton) {
            if (!request.bookmakerConfig.submitButton.optional) {
              throw new Error("Submit button not found.");
            }
            await appendLog(paths, "optional submit button did not appear; treating reviewButton as final placement action");
            screenshots.push(await screenshot(page, paths, "placement-clicked"));
          } else {
            await sleepFor(sleep, runtime, random);
            await clickHuman(page, submitButton, cursorPos, { sleep, random, minClickIntervalMs: runtime.minClickIntervalMs, lastClickAt });
            screenshots.push(await screenshot(page, paths, "submit-clicked"));
          }
        } else {
          // Single-step flow: reviewButton IS the final placement action (e.g. "Pariează X RON")
          screenshots.push(await screenshot(page, paths, "placement-clicked"));
          await appendLog(paths, "single-step placement: reviewButton is the final submit action");
        }

        const authStateSupported =
          (request.bookmakerConfig.loginSuccess?.selectors?.length ?? 0) > 0 ||
          (request.bookmakerConfig.loginFailure?.selectors?.length ?? 0) > 0 ||
          (request.bookmakerConfig.username?.selectors?.length ?? 0) > 0 ||
          (request.bookmakerConfig.password?.selectors?.length ?? 0) > 0 ||
          (request.bookmakerConfig.loginSubmit?.selectors?.length ?? 0) > 0;
        if (authStateSupported) {
          const sessionStillActive = await checkSessionActive(
            page,
            request.bookmakerConfig,
            primaryBet,
            {
              timeoutMs: Math.min(runtime.pageTimeoutMs, 3_000),
              sleep,
              pollIntervalMs: 100,
            },
          );
          if (!sessionStillActive) {
            screenshots.push(await screenshot(page, paths, "auth-lost-after-submit"));
            throw new Error(
              "Authentication state was not active after the placement click. Refusing to classify the bet as submitted.",
            );
          }
        }

        let betslipConfirmed = false;
        if (request.bookmakerConfig.receiptSuccess?.selectors?.length) {
          const receiptTimeoutMs = Math.max(runtime.pageTimeoutMs, 15_000);
          const placementOutcome = await waitForPlacementOutcome(
            page,
            request.bookmakerConfig,
            primaryBet,
            { timeoutMs: receiptTimeoutMs, sleep, authStateSupported },
          );
          if (placementOutcome === "receipt") {
            await appendLog(paths, "receipt element found — bet placed successfully");
            betslipConfirmed = true;
          } else if (placementOutcome === "auth_lost") {
            screenshots.push(await screenshot(page, paths, "auth-lost-after-submit"));
            throw new Error(
              "Authentication state was lost during placement confirmation. Refusing to classify the bet as submitted.",
            );
          } else if (request.bookmakerConfig.receiptSuccess.optional) {
            await sleep(2_000);
            if (authStateSupported) {
              const sessionStillActive = await checkSessionActive(
                page,
                request.bookmakerConfig,
                primaryBet,
                {
                  timeoutMs: 500,
                  sleep,
                  pollIntervalMs: 50,
                },
              );
              if (!sessionStillActive) {
                screenshots.push(await screenshot(page, paths, "auth-lost-after-submit"));
                throw new Error(
                  "Authentication state was lost during placement confirmation. Refusing to classify the bet as submitted.",
                );
              }
            }
            const betslipStillVisible = await hasVisibleActiveBetslipState(page, request.bookmakerConfig, primaryBet);
            screenshots.push(await screenshot(page, paths, "unconfirmed-placement"));
            await appendLog(
              paths,
              betslipStillVisible
                ? "WARNING: receipt not found and betslip still visible; marking as submitted_unconfirmed"
                : "WARNING: receipt not found even though betslip cleared; refusing to infer success without an authenticated receipt",
            );
          } else {
            throw new Error("Receipt success indicator did not appear before timeout.");
          }
        }

        let historyVerified = false;
        const historyVerificationConfigured =
          typeof request.bookmakerConfig.historyUrl === "string" &&
          request.bookmakerConfig.historyUrl.length > 0 &&
          (request.bookmakerConfig.historySelection?.selectors?.length ?? 0) > 0;
        if (historyVerificationConfigured) {
          historyVerified = await verifyHistoryListing(
            page,
            request.bookmakerConfig,
            primaryBet,
            runtime,
            paths,
            screenshots,
            { sleep, random },
          );
        }

        const placementStatus = betslipConfirmed && (!historyVerificationConfigured || historyVerified)
          ? "completed"
          : "submitted_unconfirmed";
        const placedAt = new Date();
        let placedBetId: string | null = null;
        for (let i = 0; i < betsToPlace.length; i++) {
          const id = await persistPlacedBet({ ...request, bet: betsToPlace[i]! }, {
            executionStatus: placementStatus,
            sessionId,
            paths,
            reviewSummaryText: i === 0 ? reviewSummaryText : null,
            matchedSelection: matchedSelections[i]?.trim() || null,
            acceptedOdds: i === 0 ? acceptedOdds : null,
            placedAt,
          });
          if (i === 0) placedBetId = id;
        }
        await appendLog(paths, `bet ${placementStatus}${placedBetId ? ` placedBetId=${placedBetId}` : ""}`);

        return {
          status: placementStatus,
          sessionId,
          summary,
          artifactDir: paths.root,
          logPath: paths.logPath,
          screenshots,
          videoDir: paths.videoDir,
          reviewSummaryText,
          placedBetId,
          risk,
          failureReason: placementStatus === "submitted_unconfirmed"
            ? historyVerificationConfigured && !historyVerified
              ? "Bet was submitted but the configured bet-history verification did not show the placed selection. Check the account manually."
              : "Bet was submitted but placement confirmation could not be verified. Check the account manually."
            : null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appendLog(paths, `failure: ${message}`);
        if (page) {
          const failureShot = await screenshot(page, paths, "failure").catch(() => null);
          if (failureShot) screenshots.push(failureShot);
        }
        if (deps.sendAlert) {
          await deps.sendAlert(
            `BBA automation failed for ${request.bet.matchLabel} @ ${request.bookmakerConfig.bookmaker}: ${message}`,
          ).catch((alertErr) => {
            logger.warn({ err: alertErr }, "betting browser automation alert failed");
          });
        }
        return {
          status: "failed",
          sessionId,
          summary,
          artifactDir: paths.root,
          logPath: paths.logPath,
          screenshots,
          videoDir: paths.videoDir,
          reviewSummaryText: null,
          placedBetId: null,
          risk,
          failureReason: message,
        };
      } finally {
        await context?.close().catch((err: unknown) => {
          logger.warn({ err }, "betting browser automation: context close failed");
        });
        await browser?.close().catch((err: unknown) => {
          logger.warn({ err }, "betting browser automation: browser close failed");
        });
        if (chromeProcess && chromeProcess.exitCode === null) {
          try {
            chromeProcess.kill();
          } catch (err) {
            logger.warn({ err }, "betting browser automation: chrome process kill failed");
          }
        }
        if (clonedUserDataDir) {
          await fs.rm(clonedUserDataDir, { recursive: true, force: true }).catch((err: unknown) => {
            logger.warn({ err, clonedUserDataDir }, "betting browser automation: cloned profile cleanup failed");
          });
        }
      }
    },
  };
}
