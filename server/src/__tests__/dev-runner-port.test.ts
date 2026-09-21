import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_SERVER_PORT,
  findPaperclipConfigPath,
  readConfiguredServerPort,
  resolveRequestedDevServerPort,
} from "../../../scripts/dev-runner-port.ts";

const tempRoots: string[] = [];

function makeRepo(config?: Record<string, unknown>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-runner-port-"));
  tempRoots.push(root);
  if (config) {
    mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    writeFileSync(
      path.join(root, ".paperclip", "config.json"),
      JSON.stringify(config, null, 2),
      "utf8",
    );
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("resolveRequestedDevServerPort", () => {
  it("uses the repository config port when PORT is unset", () => {
    // The regression that motivated this: the runner read only PORT and
    // believed 3100 while the child bound the configured 3101 (TES-2189).
    const repoRoot = makeRepo({ server: { port: 3101 } });

    expect(resolveRequestedDevServerPort({ env: {}, startDir: repoRoot })).toBe(3101);
  });

  it("prefers PORT over the config file, matching server/src/config.ts", () => {
    const repoRoot = makeRepo({ server: { port: 3101 } });

    expect(resolveRequestedDevServerPort({ env: { PORT: "4200" }, startDir: repoRoot })).toBe(4200);
  });

  it.each([
    ["", "empty"],
    ["not-a-port", "non-numeric"],
    ["0", "zero"],
    ["70000", "out of range"],
  ])("ignores an unusable PORT value (%s, %s) and falls back to the config", (port) => {
    const repoRoot = makeRepo({ server: { port: 3101 } });

    expect(resolveRequestedDevServerPort({ env: { PORT: port }, startDir: repoRoot })).toBe(3101);
  });

  it("finds the config by walking up from a nested working directory", () => {
    const repoRoot = makeRepo({ server: { port: 3105 } });
    const nested = path.join(repoRoot, "server", "src");
    mkdirSync(nested, { recursive: true });

    expect(resolveRequestedDevServerPort({ env: {}, startDir: nested })).toBe(3105);
  });

  it("honours PAPERCLIP_CONFIG ahead of the ancestor walk", () => {
    const repoRoot = makeRepo({ server: { port: 3101 } });
    const overrideDir = makeRepo({ server: { port: 3999 } });

    expect(
      resolveRequestedDevServerPort({
        env: { PAPERCLIP_CONFIG: path.join(overrideDir, ".paperclip", "config.json") },
        startDir: repoRoot,
      }),
    ).toBe(3999);
  });

  it("falls back to the instance config when the checkout has none", () => {
    const repoRoot = makeRepo();
    const instanceDir = makeRepo({ server: { port: 3200 } });

    expect(
      resolveRequestedDevServerPort({
        env: {},
        startDir: repoRoot,
        fallbackConfigPath: path.join(instanceDir, ".paperclip", "config.json"),
      }),
    ).toBe(3200);
  });

  it("falls back to the default port when nothing configures one", () => {
    const repoRoot = makeRepo({ server: {} });

    expect(resolveRequestedDevServerPort({ env: {}, startDir: repoRoot })).toBe(
      DEFAULT_DEV_SERVER_PORT,
    );
  });

  it("treats a malformed config as unconfigured rather than throwing", () => {
    const repoRoot = makeRepo();
    mkdirSync(path.join(repoRoot, ".paperclip"), { recursive: true });
    writeFileSync(path.join(repoRoot, ".paperclip", "config.json"), "{ not json", "utf8");

    expect(resolveRequestedDevServerPort({ env: {}, startDir: repoRoot })).toBe(
      DEFAULT_DEV_SERVER_PORT,
    );
  });
});

describe("findPaperclipConfigPath", () => {
  it("returns null when no config exists anywhere above the start directory", () => {
    const repoRoot = makeRepo();

    expect(findPaperclipConfigPath({ env: {}, startDir: repoRoot })).toBeNull();
  });
});

describe("readConfiguredServerPort", () => {
  it("returns null for a missing path", () => {
    expect(readConfiguredServerPort(null)).toBeNull();
  });

  it("rejects a non-integer port", () => {
    const repoRoot = makeRepo({ server: { port: 3101.5 } });

    expect(readConfiguredServerPort(path.join(repoRoot, ".paperclip", "config.json"))).toBeNull();
  });
});
