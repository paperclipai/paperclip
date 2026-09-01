import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
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

  it("copies static runtime asset directories into dist", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    expect(buildScript).toContain(
      "mkdir -p dist/onboarding-assets dist/built-ins",
    );
    expect(buildScript).toContain(
      "cp -R src/onboarding-assets/. dist/onboarding-assets/",
    );
    expect(buildScript).toContain("cp -R src/built-ins/. dist/built-ins/");
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
    expect(packageJson.scripts?.build).toContain(
      "cp -R ../packages/paperclip-runner/dist/. dist/vendor/paperclip-runner/",
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
