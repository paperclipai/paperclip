import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkerEnvironment,
  getDesktopTitlebarThemeConfig,
  readDesktopThemePreference,
  resolveDesktopPreferencesPath,
  resolveDesktopTheme,
  resolveServerEntrypoint,
  resolveDesktopUserDataDir,
  type DesktopRuntimeInput,
  writeDesktopThemePreference,
} from "../runtime.js";

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }

  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildInput(mode: DesktopRuntimeInput["mode"]): DesktopRuntimeInput {
  return {
    appRoot: "C:\\paperclip\\desktop-electron",
    repoRoot: "C:\\paperclip",
    userDataDir: "C:\\Users\\chenj\\AppData\\Roaming\\Paperclip",
    mode,
  };
}

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-desktop-runtime-"));
  TEMP_DIRS.push(dir);
  return dir;
}

describe("buildWorkerEnvironment", () => {
  it("forces packaged workers onto the bundled static UI", () => {
    process.env.SERVE_UI = "false";
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "true";
    process.env.PAPERCLIP_HOME = "C:\\legacy-paperclip-home";
    process.env.PAPERCLIP_CONFIG = "C:\\legacy\\config.json";
    process.env.PAPERCLIP_CONTEXT = "C:\\legacy\\context.json";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "legacy-worktree";
    process.env.PORT = "3201";

    const env = buildWorkerEnvironment(buildInput("packaged"));

    expect(env.PAPERCLIP_DESKTOP_MODE).toBe("packaged");
    expect(env.PAPERCLIP_DESKTOP_SERVER_ENTRY).toBe(
      path.resolve(
        "C:\\paperclip\\desktop-electron",
        "..",
        "app-runtime",
        "server",
        "dist",
        "index.js",
      ),
    );
    expect(env.SERVE_UI).toBe("true");
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBe("false");
    expect(env.PAPERCLIP_HOME).toBe("C:\\legacy-paperclip-home");
    expect(env.PAPERCLIP_CONFIG).toBe(
      path.resolve("C:\\legacy-paperclip-home", "instances", "default", "config.json"),
    );
    expect(env.PAPERCLIP_CONTEXT).toBe(
      path.resolve("C:\\legacy-paperclip-home", "context.json"),
    );
    expect(env.PAPERCLIP_IN_WORKTREE).toBe("");
    expect(env.PAPERCLIP_WORKTREE_NAME).toBe("");
    expect(env.PORT).toBe("3201");
  });

  it("falls back to the legacy packaged server location when the split-shell layout is absent", () => {
    const baseDir = createTempDir();
    const appRoot = path.join(baseDir, "app");
    const legacyEntrypoint = path.join(
      baseDir,
      "app-runtime",
      "node_modules",
      "@penclipai",
      "server",
      "dist",
      "index.js",
    );

    fs.mkdirSync(appRoot, { recursive: true });
    fs.mkdirSync(path.dirname(legacyEntrypoint), { recursive: true });
    fs.writeFileSync(legacyEntrypoint, "", "utf8");

    expect(resolveServerEntrypoint({
      appRoot,
      repoRoot: "C:\\paperclip",
      userDataDir: "C:\\Users\\chenj\\AppData\\Roaming\\Paperclip",
      mode: "packaged",
    })).toBe(legacyEntrypoint);
  });

  it("keeps development workers on Vite middleware", () => {
    process.env.SERVE_UI = "false";
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";

    const env = buildWorkerEnvironment(buildInput("development"));

    expect(env.PAPERCLIP_DESKTOP_MODE).toBe("development");
    expect(env.PAPERCLIP_DESKTOP_SERVER_ENTRY).toBe(
      path.resolve("C:\\paperclip", "server", "src", "index.ts"),
    );
    expect(env.PAPERCLIP_UI_DEV_MIDDLEWARE).toBe("true");
    expect(env.SERVE_UI).toBe("false");
  });

  it("uses a contrasting title bar icon filter in dark mode", () => {
    expect(getDesktopTitlebarThemeConfig("light").iconFilter).toBe("none");
    expect(getDesktopTitlebarThemeConfig("dark").iconFilter).toContain("invert(1)");
  });

  it("prefers the saved desktop theme over the system fallback", () => {
    const userDataDir = createTempDir();
    const preferencesPath = resolveDesktopPreferencesPath(userDataDir);

    writeDesktopThemePreference(preferencesPath, "light");

    expect(readDesktopThemePreference(preferencesPath)).toBe("light");
    expect(resolveDesktopTheme(userDataDir, true)).toBe("light");
  });

  it("falls back to the system theme when desktop preferences are missing or invalid", () => {
    const missingUserDataDir = createTempDir();
    expect(resolveDesktopTheme(missingUserDataDir, true)).toBe("dark");
    expect(resolveDesktopTheme(missingUserDataDir, false)).toBe("light");

    const invalidUserDataDir = createTempDir();
    fs.writeFileSync(resolveDesktopPreferencesPath(invalidUserDataDir), '{"theme":"sepia"}', "utf8");
    expect(readDesktopThemePreference(resolveDesktopPreferencesPath(invalidUserDataDir))).toBeNull();
    expect(resolveDesktopTheme(invalidUserDataDir, false)).toBe("light");
  });

  it("allows tests to override the desktop user data directory", () => {
    process.env.PAPERCLIP_DESKTOP_USER_DATA_DIR = "C:\\temp\\paperclip-desktop-user-data";

    expect(resolveDesktopUserDataDir("C:\\Users\\chenj\\AppData\\Roaming\\Paperclip CN")).toBe(
      path.resolve("C:\\temp\\paperclip-desktop-user-data"),
    );
  });
});
