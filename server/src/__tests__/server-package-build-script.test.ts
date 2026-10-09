import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);
const copyBuildAssetsPath = fileURLToPath(
  new URL("../../scripts/copy-build-assets.mjs", import.meta.url),
);
const runnerShimPath = fileURLToPath(
  new URL("../vendor/paperclip-runner/index.ts", import.meta.url),
);
const evidenceClassifierPath = fileURLToPath(
  new URL("../services/native-runtime/evidence-classifier.ts", import.meta.url),
);
const workspaceDiffReprojectionPath = fileURLToPath(
  new URL("../services/provider-trace-workspace-diff-reprojection.ts", import.meta.url),
);

describe("server package build script", () => {
  it("builds the compiled package entry during prepack", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.prepack).toBe(
      "pnpm run prepare:ui-dist && pnpm run build",
    );
  });

  it("copies static runtime asset directories through the cross-platform helper", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    expect(buildScript).toContain("node scripts/copy-build-assets.mjs");
    const copyScript = readFileSync(copyBuildAssetsPath, "utf8");
    expect(copyScript).toContain('["src/onboarding-assets", "dist/onboarding-assets"]');
    expect(copyScript).toContain('["src/built-ins", "dist/built-ins"]');
  });

  it("vendors the private runner runtime without a production workspace dependency", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(
      packageJson.dependencies?.["@paperclipai/paperclip-runner"],
    ).toBeUndefined();
    expect(packageJson.devDependencies?.["@paperclipai/paperclip-runner"]).toBe(
      "workspace:*",
    );
    expect(packageJson.scripts?.["prepare:runner-vendor"]).toBe(
      "pnpm --filter @paperclipai/paperclip-runner build",
    );
    expect(packageJson.scripts?.build).toContain("node scripts/copy-build-assets.mjs");
    expect(readFileSync(copyBuildAssetsPath, "utf8")).toContain(
      '["../packages/paperclip-runner/dist", "dist/vendor/paperclip-runner"]',
    );
  });

  it("replaces an existing read-only image manifest with the build's copy step", () => {
    const root = mkdtempSync(path.join(tmpdir(), "runner-vendor-copy-"));
    try {
      const serverRoot = path.join(root, "server");
      const copyScript = path.join(serverRoot, "scripts", "copy-build-assets.mjs");
      mkdirSync(path.dirname(copyScript), { recursive: true });
      copyFileSync(copyBuildAssetsPath, copyScript);
      for (const sourceDirectory of [
        "src/onboarding-assets",
        "src/built-ins",
        "src/services/scripts",
        "../packages/paperclip-runner/dist",
      ]) {
        mkdirSync(path.resolve(serverRoot, sourceDirectory), { recursive: true });
      }
      const relative = "remote-provider-packs/linux-x64/provider-pack.json";
      const source = path.join(root, "packages/paperclip-runner/dist", relative);
      const destination = path.join(serverRoot, "dist/vendor/paperclip-runner", relative);
      mkdirSync(path.dirname(source), { recursive: true });
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(source, "qualified image identity", { mode: 0o444 });
      writeFileSync(destination, "previous image identity", { mode: 0o444 });
      execFileSync(process.execPath, [copyScript], { cwd: serverRoot });
      expect(readFileSync(destination, "utf8")).toBe("qualified image identity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies vendored runner dependencies are mirrored before building", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    // See scripts/verify-runner-vendor-dependencies.mjs: packages/paperclip-runner
    // is vendored with a raw copy of its compiled dist/, so every runtime
    // dependency it imports must also be a direct dependency of server. This
    // check derives that requirement from an esbuild scan of the vendored
    // entry points instead of relying on a human to have kept a hand-copied
    // list in sync (the smol-toml incident in #13110/#13116).
    expect(packageJson.scripts?.build).toContain(
      "node scripts/verify-runner-vendor-dependencies.mjs",
    );
  });

  it("loads runner source when the source server starts before workspace builds", () => {
    const shim = readFileSync(runnerShimPath, "utf8");

    expect(shim).toContain(
      '"../../../../packages/paperclip-runner/src/index.ts"',
    );
    expect(shim).not.toContain(
      'export * from "@paperclipai/paperclip-runner"',
    );
  });

  it("routes source-mode runtime imports through the runner shim", () => {
    for (const consumerPath of [
      evidenceClassifierPath,
      workspaceDiffReprojectionPath,
    ]) {
      const consumer = readFileSync(consumerPath, "utf8");

      expect(consumer).toContain('vendor/paperclip-runner/index.js"');
      expect(consumer).not.toContain('from "@paperclipai/paperclip-runner"');
    }
  });
});
