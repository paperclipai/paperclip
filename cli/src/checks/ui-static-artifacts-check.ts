import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export function monorepoRootFromCliPackage(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function hasStaticUiArtifacts(repoRoot: string): boolean {
  const candidates = [
    path.join(repoRoot, "ui", "dist", "index.html"),
    path.join(repoRoot, "server", "ui-dist", "index.html"),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function isMonorepoDevLayout(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, "server", "src", "index.ts"));
}

export function uiStaticArtifactsCheckForRepoRoot(config: PaperclipConfig, repoRoot: string): CheckResult {
  const devMiddlewareOff = process.env.PAPERCLIP_UI_DEV_MIDDLEWARE === "false";
  if (!devMiddlewareOff) {
    return {
      name: "Static UI build",
      status: "pass",
      message: "Skipped (PAPERCLIP_UI_DEV_MIDDLEWARE is not false)",
    };
  }

  if (!config.server.serveUi) {
    return {
      name: "Static UI build",
      status: "pass",
      message: "Skipped (serveUi is disabled)",
    };
  }

  if (!isMonorepoDevLayout(repoRoot)) {
    return {
      name: "Static UI build",
      status: "pass",
      message: "Skipped (not a monorepo dev layout)",
    };
  }

  if (hasStaticUiArtifacts(repoRoot)) {
    return {
      name: "Static UI build",
      status: "pass",
      message: "ui/dist or server/ui-dist present",
    };
  }

  return {
    name: "Static UI build",
    status: "fail",
    message: "No static UI artifacts (ui/dist/index.html or server/ui-dist/index.html)",
    canRepair: false,
    repairHint: "Run `pnpm build` at the repo root, then re-run doctor.",
  };
}

/**
 * When serving UI without Vite middleware, static build output must exist in a dev checkout.
 */
export function uiStaticArtifactsCheck(config: PaperclipConfig): CheckResult {
  return uiStaticArtifactsCheckForRepoRoot(config, monorepoRootFromCliPackage());
}
