import { describe, expect, it } from "vitest";
import {
  resolveVitestRootConfigContext,
  resolveVitestSourceRoot,
} from "../../../scripts/vitest-root-config.mjs";

const REQUIRED_MANIFESTS = [
  "packages/db/package.json",
  "packages/shared/package.json",
  "packages/adapter-utils/package.json",
  "packages/adapters/codex-local/package.json",
  "packages/adapters/cursor-local/package.json",
  "packages/adapters/opencode-local/package.json",
];

function withBase(baseDir: string, relativePath: string): string {
  return `${baseDir}/${relativePath}`;
}

describe("vitest root config resolver", () => {
  it("uses root source when required workspace manifests exist in root", () => {
    const root = "/repo";
    const existing = new Set(REQUIRED_MANIFESTS.map((relativePath) => withBase(root, relativePath)));

    const sourceRoot = resolveVitestSourceRoot({
      repoRoot: root,
      fileExists: (candidate: string) => existing.has(candidate),
    });

    expect(sourceRoot).toBe("/repo");
  });

  it("builds root projects/aliases and keeps root-only excludes in root mode", () => {
    const root = "/repo";
    const existing = new Set(REQUIRED_MANIFESTS.map((relativePath) => withBase(root, relativePath)));

    const context = resolveVitestRootConfigContext({
      repoRoot: root,
      fileExists: (candidate: string) => existing.has(candidate),
    });

    expect(context.projects).toEqual([
      "packages/db",
      "packages/shared",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ]);
    expect(context.exclude).toContain("**/paperclip-orginal/**");
    expect(context.alias["@paperclipai/adapter-utils/server-utils"]).toBe(
      "/repo/packages/adapter-utils/src/server-utils.ts",
    );
    expect(context.alias["@paperclipai/plugin-sdk"]).toBe(
      "/repo/packages/plugins/sdk/src/index.ts",
    );
  });

  it("fails fast when root manifests are missing", () => {
    const root = "/repo";
    const existing = new Set<string>();

    expect(() =>
      resolveVitestSourceRoot({
        repoRoot: root,
        fileExists: (candidate: string) => existing.has(candidate),
      }))
      .toThrow("Missing workspace manifests");
  });

  it("mentions legacy mirror risk when root manifests are missing but paperclip-orginal looks complete", () => {
    const root = "/repo";
    const fallbackRoot = "/repo/paperclip-orginal";
    const existing = new Set(
      REQUIRED_MANIFESTS.map((relativePath) => withBase(fallbackRoot, relativePath)),
    );

    expect(() =>
      resolveVitestRootConfigContext({
        repoRoot: root,
        fileExists: (candidate: string) => existing.has(candidate),
      }))
      .toThrow("paperclip-orginal");
  });
});
