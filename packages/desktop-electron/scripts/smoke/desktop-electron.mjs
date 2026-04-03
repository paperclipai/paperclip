#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { runPnpm } from "../utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const require = createRequire(import.meta.url);
const DESKTOP_PREFERENCES_FILENAME = "desktop-preferences.json";
const DESKTOP_THEMES = ["dark", "light"];

function parseArgs(argv) {
  const args = { mode: "dev" };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      args.mode = argv[index + 1] ?? args.mode;
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      args.mode = arg.slice("--mode=".length);
    }
  }

  return args;
}

function resolveExpectedLocale() {
  const raw =
    process.env.PAPERCLIP_DESKTOP_SMOKE_EXPECT_LOCALE ??
    Intl.DateTimeFormat().resolvedOptions().locale ??
    "en";
  return raw.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function getSplashExpectation(locale, theme) {
  if (locale === "zh-CN") {
    return {
      statuses: [
        "\u6b63\u5728\u6253\u5f00 Paperclip",
        "\u9a6c\u4e0a\u5c31\u597d\uff0c\u6b63\u5728\u8fde\u63a5\u4f60\u7684\u672c\u5730\u5de5\u4f5c\u53f0",
      ],
      footer: "\u00a9 2026 Paperclip CN",
      theme,
      tokens: theme === "dark"
        ? { backgroundStart: "#1c1c1e", text: "#f5f5f7" }
        : { backgroundStart: "#f5f2ea", text: "#1c1c1f" },
    };
  }

  return {
    statuses: [
      "Opening Paperclip",
      "Almost there. Connecting your local workspace.",
    ],
    footer: "\u00a9 2026 Paperclip CN",
    theme,
    tokens: theme === "dark"
      ? { backgroundStart: "#1c1c1e", text: "#f5f5f7" }
      : { backgroundStart: "#f5f2ea", text: "#1c1c1f" },
  };
}

async function createSmokeUserDataDir(mode, theme) {
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `paperclip-desktop-smoke-${mode}-${theme}-`),
  );

  await fs.promises.writeFile(
    path.resolve(userDataDir, DESKTOP_PREFERENCES_FILENAME),
    `${JSON.stringify({ theme }, null, 2)}\n`,
    "utf8",
  );

  return userDataDir;
}

function buildLaunchEnv(userDataDir) {
  return {
    ...process.env,
    PAPERCLIP_DESKTOP_SMOKE_START_DELAY_MS: process.env.PAPERCLIP_DESKTOP_SMOKE_START_DELAY_MS ?? "1800",
    PAPERCLIP_DESKTOP_USER_DATA_DIR: userDataDir,
    PAPERCLIP_HOME: path.resolve(userDataDir, "runtime"),
  };
}

function resolveDevLaunchOptions(userDataDir) {
  const electronBin =
    process.platform === "win32"
      ? require("electron")
      : path.resolve(packageDir, "node_modules", ".bin", "electron");

  return {
    executablePath: electronBin,
    args: [path.resolve(packageDir, "dist", "main.js")],
    cwd: packageDir,
    env: {
      ...buildLaunchEnv(userDataDir),
      PAPERCLIP_DESKTOP_DEV: "true",
    },
  };
}

function prepareDevLaunch() {
  runPnpm(["--dir", repoRoot, "--filter", "@penclipai/server...", "build"], { cwd: repoRoot });
  runPnpm(["--dir", packageDir, "build"], { cwd: packageDir });
}

function killProcessTree(pid) {
  if (!pid || Number.isNaN(pid)) {
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      process.env.comspec ?? "cmd.exe",
      ["/d", "/s", "/c", "taskkill", "/PID", String(pid), "/T", "/F"],
      {
        cwd: packageDir,
        stdio: "ignore",
        windowsHide: true,
      },
    );

    if (result.error) {
      throw result.error;
    }

    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

function resolvePackagedExecutable() {
  const winUnpackedDir = path.resolve(packageDir, "release", "win-unpacked");
  const candidates = [
    path.resolve(winUnpackedDir, "Paperclip CN.exe"),
    path.resolve(winUnpackedDir, "Paperclip-CN.exe"),
    path.resolve(winUnpackedDir, "electron.exe"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const discoveredExe = fs
    .readdirSync(winUnpackedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => path.resolve(winUnpackedDir, entry.name))
    .at(0);

  if (discoveredExe) {
    return discoveredExe;
  }

  throw new Error(
    `Packaged desktop executable not found in ${winUnpackedDir}. Run "pnpm desktop:dist:win" first.`,
  );
}

function resolvePackagedLaunchOptions(userDataDir) {
  const executablePath = resolvePackagedExecutable();

  return {
    executablePath,
    args: [],
    cwd: path.dirname(executablePath),
    env: buildLaunchEnv(userDataDir),
  };
}

async function waitForHealth(origin, timeoutMs = 90_000) {
  const start = Date.now();
  const healthUrl = new URL("/api/health", origin).toString();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  throw new Error(`Timed out waiting for desktop health endpoint at ${healthUrl}`);
}

async function createSmokeCompany(origin, theme) {
  const response = await fetch(new URL("/api/companies", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: `Desktop Smoke ${theme} ${Date.now()}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create smoke company (${response.status}): ${await response.text()}`);
  }

  return await response.json();
}

async function readDesktopLayoutState(page) {
  return await page.evaluate(() => {
    const rect = (element) => {
      if (!(element instanceof Element)) return null;
      const box = element.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        height: box.height,
      };
    };

    const root = document.querySelector("#root");
    const appShell = root?.firstElementChild ?? null;
    const cetContainer = document.querySelector(".cet-container");
    const main = document.querySelector("#main-content");

    return {
      appShellPaddingTop:
        appShell instanceof Element ? Number.parseFloat(getComputedStyle(appShell).paddingTop || "0") : null,
      cetContainer: rect(cetContainer),
      main: rect(main),
      root: rect(root),
    };
  });
}

function assertDesktopLayoutState(state, routeLabel) {
  if (!state.cetContainer || !state.root || !state.main) {
    throw new Error(`Missing layout nodes while validating ${routeLabel}.`);
  }

  if (state.root.bottom > state.cetContainer.bottom + 1) {
    throw new Error(
      `${routeLabel} root overflowed the CET container (${state.root.bottom} > ${state.cetContainer.bottom}).`,
    );
  }

  if (state.main.bottom > state.cetContainer.bottom + 1) {
    throw new Error(
      `${routeLabel} main content overflowed the CET container (${state.main.bottom} > ${state.cetContainer.bottom}).`,
    );
  }

  if ((state.appShellPaddingTop ?? 0) > 1) {
    throw new Error(
      `${routeLabel} retained an unexpected desktop top inset (${state.appShellPaddingTop}px).`,
    );
  }
}

async function ensureDirectory(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeFailureSnapshot(page, artifactDir, locale) {
  const debugPath = path.resolve(artifactDir, `failure-${locale}.html`);
  await fs.promises.writeFile(debugPath, await page.content(), "utf8");
}

async function runThemeScenario(mode, theme, artifactDir) {
  const userDataDir = await createSmokeUserDataDir(mode, theme);
  const launchOptions = mode === "dev"
    ? resolveDevLaunchOptions(userDataDir)
    : resolvePackagedLaunchOptions(userDataDir);
  const electronApp = await electron.launch(launchOptions);
  const launchedProcess = electronApp.process();
  const launchedPid = launchedProcess?.pid ?? null;

  try {
    const actualLocale = await electronApp.evaluate(({ app }) => app.getLocale());
    const locale =
      typeof actualLocale === "string" && actualLocale.toLowerCase().startsWith("zh")
        ? "zh-CN"
        : resolveExpectedLocale();
    const expectation = getSplashExpectation(locale, theme);
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    try {
      await page.locator('[data-testid="splash-logo"]').waitFor({ timeout: 20_000 });
      await page.locator('[data-testid="splash-progress"]').waitFor({ timeout: 10_000 });
      await page.locator('[data-testid="splash-status"]').waitFor({ timeout: 10_000 });

      const splashState = await page.evaluate(() => {
        const statusText =
          document.querySelector('[data-testid="splash-status"]')?.textContent?.trim() ?? "";
        const footerText =
          document.querySelector('[data-testid="splash-footer"]')?.textContent?.trim() ?? "";
        const logoTag = document.querySelector('[data-testid="splash-logo"]')?.tagName ?? null;
        const progressBar = document.querySelector('[data-testid="splash-progress-bar"]');
        const progressVisible =
          progressBar instanceof HTMLElement && getComputedStyle(progressBar).display !== "none";
        const rootStyles = getComputedStyle(document.documentElement);

        return {
          backgroundStart: rootStyles.getPropertyValue("--bg-start").trim(),
          footerText,
          hasHeading: Boolean(document.querySelector("h1")),
          logoTag,
          progressVisible,
          statusText,
          textColor: rootStyles.getPropertyValue("--text").trim(),
        };
      });

      if (!expectation.statuses.includes(splashState.statusText)) {
        throw new Error(
          `Unexpected splash status "${splashState.statusText}" (expected one of ${expectation.statuses.join(", ")}).`,
        );
      }

      if (splashState.footerText !== expectation.footer) {
        throw new Error(
          `Unexpected splash footer "${splashState.footerText}" (expected "${expectation.footer}").`,
        );
      }

      if (splashState.logoTag !== "IMG") {
        throw new Error(`Expected splash logo to render as IMG, received ${String(splashState.logoTag)}.`);
      }

      if (!splashState.progressVisible) {
        throw new Error("Expected splash progress indicator to be visible before the app loads.");
      }

      if (splashState.hasHeading) {
        throw new Error("Splash should not render a large heading element in the minimalist layout.");
      }

      if (splashState.backgroundStart !== expectation.tokens.backgroundStart) {
        throw new Error(
          `Unexpected splash background "${splashState.backgroundStart}" for ${theme} theme (expected "${expectation.tokens.backgroundStart}").`,
        );
      }

      if (splashState.textColor !== expectation.tokens.text) {
        throw new Error(
          `Unexpected splash text token "${splashState.textColor}" for ${theme} theme (expected "${expectation.tokens.text}").`,
        );
      }
    } catch (error) {
      await writeFailureSnapshot(page, artifactDir, `${locale}-${theme}`);
      throw error;
    }

    const splashShot = path.resolve(artifactDir, `splash-${locale}-${theme}.png`);
    await page.screenshot({ path: splashShot, fullPage: true });

    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/?/, { timeout: 90_000 });
    const currentUrl = page.url();
    const origin = new URL(currentUrl).origin;
    const health = await waitForHealth(origin);
    if (!health || typeof health !== "object") {
      throw new Error("Desktop health endpoint returned an unexpected payload.");
    }

    await page.locator("#root").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const root = document.querySelector("#root");
      return Boolean(root && root.childElementCount > 0);
    }, undefined, { timeout: 30_000 });

    const company = await createSmokeCompany(origin, theme);
    await page.goto(`${origin}/${company.issuePrefix}/dashboard`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => {
      const root = document.querySelector("#root");
      const main = document.querySelector("#main-content");
      return Boolean(root && root.childElementCount > 0 && main);
    }, undefined, { timeout: 30_000 });

    const layoutState = await readDesktopLayoutState(page);
    assertDesktopLayoutState(layoutState, "desktop dashboard");

    const boardShot = path.resolve(artifactDir, `board-${locale}-${theme}.png`);
    await page.screenshot({ path: boardShot, fullPage: true });

    console.log(`[desktop-smoke] ${mode} mode passed for ${theme} theme.`);
    console.log(`[desktop-smoke] Splash screenshot: ${splashShot}`);
    console.log(`[desktop-smoke] App screenshot: ${boardShot}`);
    console.log(`[desktop-smoke] Health: ${JSON.stringify(health)}`);
  } finally {
    try {
      await electronApp.close();
    } finally {
      killProcessTree(launchedPid);
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
    }
  }
}

async function run() {
  const { mode } = parseArgs(process.argv.slice(2));
  if (!["dev", "packaged"].includes(mode)) {
    throw new Error(`Unsupported smoke mode "${mode}". Use "dev" or "packaged".`);
  }

  const artifactDir = path.resolve(packageDir, ".artifacts", "smoke", mode);

  await ensureDirectory(artifactDir);

  if (mode === "dev") {
    prepareDevLaunch();
  }

  for (const theme of DESKTOP_THEMES) {
    await runThemeScenario(mode, theme, artifactDir);
  }
}

void run().catch((error) => {
  console.error("[desktop-smoke] Failed:", error);
  process.exitCode = 1;
});
