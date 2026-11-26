import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_VENDOR_BUILD_COMMAND } from "../../scripts/prepare-runner-vendor.mjs";
import { buildRunnerBuildPlan } from "../../../packages/paperclip-runner/scripts/run-build.mjs";

type RunnerBuildStep = {
  label: string;
  command: string;
  args: string[];
};

type RunnerBuildPhase = {
  name: string;
  mode: string;
  steps?: RunnerBuildStep[];
  chains?: Array<{ name: string; steps: RunnerBuildStep[] }>;
};

function phaseSteps(phase: RunnerBuildPhase): RunnerBuildStep[] {
  if (phase.steps) return phase.steps;
  return (phase.chains ?? []).flatMap((chain) => chain.steps);
}

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
    // prepare-runner-vendor.mjs reuses a Runner build whose recorded inputs
    // are unchanged (the `pnpm -r build` case) and otherwise runs the Runner's
    // full build, which is what a standalone server build (the Dockerfile's
    // path) relies on. Pin both the indirection and the command behind it.
    expect(packageJson.scripts?.["prepare:runner-vendor"]).toBe(
      "node scripts/prepare-runner-vendor.mjs",
    );
    expect(RUNNER_VENDOR_BUILD_COMMAND).toBe(
      "pnpm --filter @paperclipai/paperclip-runner build",
    );
    expect(packageJson.scripts?.build.startsWith("pnpm run prepare:runner-vendor && ")).toBe(true);
    expect(packageJson.scripts?.build).toContain(
      "cp -Rf ../packages/paperclip-runner/dist/. dist/vendor/paperclip-runner/",
    );
  });

  it("brackets the Runner's build with its input recording", () => {
    // The stamp prepare-runner-vendor.mjs trusts must only exist for a build
    // that completed every step and check, so it has to be written last; and
    // it must vouch for the inputs the build read, not for whatever the
    // sources are when it ends, so the digest has to be captured before the
    // first step reads anything (--begin) and compared again at the end
    // (--finish). Nothing else in the chain may touch the stamp.
    const runner = JSON.parse(readFileSync(new URL(
      "../../../packages/paperclip-runner/package.json", import.meta.url,
    ), "utf8")) as { scripts: Record<string, string> };
    expect(runner.scripts.build).toBe("node scripts/run-build.mjs");
    const phases = buildRunnerBuildPlan({ env: {} }) as RunnerBuildPhase[];
    expect(phases.length).toBeGreaterThan(2);
    expect(phases.at(0)?.mode).toBe("serial");
    expect(phaseSteps(phases.at(0)!).map((step) => step.args)).toEqual([
      ["scripts/record-build-inputs.mjs", "--begin"],
    ]);
    expect(phases.at(-1)?.mode).toBe("serial");
    expect(phaseSteps(phases.at(-1)!).map((step) => step.args)).toEqual([
      ["scripts/record-build-inputs.mjs", "--finish"],
    ]);
    const allSteps = phases.flatMap(phaseSteps);
    expect(
      allSteps.filter((step) => step.args.some((arg) => arg.includes("record-build-inputs"))),
    ).toHaveLength(2);
  });

  it("replaces an existing read-only image manifest with the build's copy step", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const step = packageJson.scripts.build.split(" && ").find((command: string) =>
      command.includes("../packages/paperclip-runner/dist/."));
    expect(step).toBeDefined();
    const [command, ...args] = step.split(" ");
    const root = mkdtempSync(path.join(tmpdir(), "runner-vendor-copy-"));
    try {
      const relative = "remote-provider-packs/linux-x64/provider-pack.json";
      const source = path.join(root, "packages/paperclip-runner/dist", relative);
      const destination = path.join(root, "server/dist/vendor/paperclip-runner", relative);
      mkdirSync(path.dirname(source), { recursive: true });
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(source, "qualified image identity", { mode: 0o444 });
      writeFileSync(destination, "previous image identity", { mode: 0o444 });
      execFileSync(command, args, { cwd: path.join(root, "server") });
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

  it("compiles the vendored Runner's TypeScript surface once per build", () => {
    // prepare:runner-vendor runs the Runner's full build whenever its recorded
    // inputs are stale or missing (every standalone server build). Each extra
    // build:typescript inside that chain (two tsc projects plus the eval-kernel
    // rebuild) costs about 7s on the CI Build job's critical path.
    // Checks that read dist/ must call their script directly, the way
    // generate-replay-goldens.mjs already does, not through a `check:*`
    // wrapper that rebuilds first for standalone use.
    const runner = JSON.parse(readFileSync(new URL(
      "../../../packages/paperclip-runner/package.json", import.meta.url,
    ), "utf8")) as { scripts: Record<string, string> };
    expect(runner.scripts.build).toBe("node scripts/run-build.mjs");
    const phases = buildRunnerBuildPlan({ env: {} }) as RunnerBuildPhase[];
    const indexedSteps = phases.flatMap((phase, phaseIndex) =>
      phaseSteps(phase).map((step) => ({ phaseIndex, step })),
    );
    const tscPrimary = indexedSteps.filter(({ step }) =>
      step.args.includes("tsconfig.json") && step.args.some((arg) => arg.endsWith("/tsc")),
    );
    const tscSurfaces = indexedSteps.filter(({ step }) =>
      step.args.includes("tsconfig.surfaces.json") && step.args.some((arg) => arg.endsWith("/tsc")),
    );
    const evalKernelBuilds = indexedSteps.filter(({ step }) =>
      step.args.includes("@paperclipai/paperclip-eval-kernel") && step.args.includes("build"),
    );
    const nestedBuildTs = indexedSteps.filter(({ step }) =>
      step.args.some((arg) => arg === "build:typescript" || (runner.scripts[arg] ?? "").includes("build:typescript")),
    );

    expect(tscPrimary).toHaveLength(1);
    expect(tscSurfaces).toHaveLength(1);
    expect(evalKernelBuilds).toHaveLength(1);
    expect(nestedBuildTs).toHaveLength(0);

    const tsPhaseIndex = Math.max(tscPrimary[0].phaseIndex, tscSurfaces[0].phaseIndex);
    const semanticContracts = indexedSteps.find(({ step }) =>
      step.args[0] === "scripts/generate-semantic-contracts.mjs" && step.args[1] === "--check",
    );
    const traceability = indexedSteps.find(({ step }) =>
      step.args[0] === "scripts/check-runner-workflow-traceability.mjs",
    );
    expect(semanticContracts).toBeDefined();
    expect(traceability).toBeDefined();
    expect(semanticContracts!.phaseIndex).toBeGreaterThan(tsPhaseIndex);
    expect(traceability!.phaseIndex).toBeGreaterThan(tsPhaseIndex);
  });

  it("ships the pinned OpenCode dependency resolved by the vendored Runner", () => {
    const server = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const runner = JSON.parse(readFileSync(new URL(
      "../../../packages/paperclip-runner/package.json", import.meta.url,
    ), "utf8"));
    // createRequire resolution is dynamic and is not covered by the import scan.
    expect(server.dependencies["opencode-ai"]).toBe("1.18.34");
    expect(server.dependencies["opencode-ai"]).toBe(runner.dependencies["opencode-ai"]);
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
