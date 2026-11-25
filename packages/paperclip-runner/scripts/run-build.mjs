import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_ARTIFACTS_VARIABLE } from "./build-runner-binary.mjs";
import { executePhases } from "./run-check-static.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

function resolvePnpmInvocation(env = process.env) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && npmExecPath.toLowerCase().includes("pnpm")) {
    if (/\.(cjs|mjs|js)$/i.test(npmExecPath)) {
      return { command: node, argsPrefix: [npmExecPath] };
    }
    return { command: npmExecPath, argsPrefix: [] };
  }
  return { command: "pnpm", argsPrefix: [] };
}

function cmd(label, command, args, cwd = packageRoot) {
  return { label, command, args, cwd, shell: command === "pnpm" && process.platform === "win32" };
}

export function buildRunnerBuildPlan({ env = process.env } = {}) {
  const pnpm = resolvePnpmInvocation(env);
  const prebuiltReleaseBinary = Boolean(env[RELEASE_ARTIFACTS_VARIABLE]?.trim());

  const preDistChecks = [
    cmd("check:protocol-manifest", node, ["scripts/generate-protocol-manifest.mjs", "--check"]),
    cmd("check:acpx-profiles", node, ["scripts/generate-acpx-profiles.mjs", "--check"]),
    cmd("check:antigravity-models", node, ["scripts/generate-antigravity-models.mjs", "--check"]),
    cmd("check:protocol-schema-module", node, ["scripts/generate-protocol-schema-module.mjs", "--check"]),
    cmd("check:acpx-sidecar-contract", node, ["scripts/generate-acpx-sidecar-contract.mjs", "--check"]),
    cmd("check:runtime-context-contract", node, ["scripts/generate-runtime-context-contract.mjs", "--check"]),
    cmd("check:provider-failure-contract", node, ["scripts/generate-provider-failure-contract.mjs", "--check"]),
    cmd("check:capability-contract", node, ["scripts/generate-capability-contract.mjs", "--check"]),
    cmd("check:capability-inventory", node, ["scripts/check-capability-inventory.mjs"]),
  ];

  const buildChains = [
    {
      name: "typescript-dist",
      steps: [
        cmd("build:eval-kernel", pnpm.command, [...pnpm.argsPrefix, "--filter", "@paperclipai/paperclip-eval-kernel", "build"]),
        cmd("tsc:version", node, ["./node_modules/typescript/bin/tsc", "--version"]),
        cmd("tsc:tsconfig", node, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]),
        cmd("tsc:surfaces", node, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.surfaces.json"]),
      ],
    },
    ...(prebuiltReleaseBinary
      ? []
      : [
          {
            name: "cargo-release-runnerd",
            steps: [
              cmd("cargo:release-runnerd", "cargo", [
                "build",
                "--release",
                "--manifest-path",
                "runner/Cargo.toml",
                "--locked",
                "-p",
                "paperclip-runner-core",
                "--bin",
                "paperclip-runnerd",
              ]),
            ],
          },
        ]),
    ...preDistChecks.map((step) => ({ name: step.label, steps: [step] })),
  ];

  return [
    {
      name: "record-begin",
      mode: "serial",
      steps: [cmd("record-build-inputs:begin", node, ["scripts/record-build-inputs.mjs", "--begin"])],
    },
    {
      name: "compile-dist-binary-and-pre-checks",
      mode: "parallel-chains",
      chains: buildChains,
    },
    {
      name: "stage-dist-assets",
      mode: "parallel",
      steps: [
        cmd("build:verified-entrypoints", node, ["scripts/build-verified-provider-entrypoints.mjs"]),
        cmd("install:copilot-assets", node, ["scripts/install-copilot-assets.mjs"]),
        cmd("build:runner-binary", node, ["scripts/build-runner-binary.mjs"]),
      ],
    },
    {
      name: "post-dist-checks",
      mode: "parallel",
      steps: [
        cmd("check:protocol-coverage", node, ["scripts/generate-protocol-coverage.mjs", "--check"]),
        cmd("check:semantic-contracts", node, ["scripts/generate-semantic-contracts.mjs", "--check"]),
        cmd("check:replay-goldens", node, ["scripts/generate-replay-goldens.mjs", "--check"]),
        cmd("check:semantic-action-catalog", node, ["scripts/generate-semantic-action-catalog.mjs", "--check"]),
        cmd("check:runner-workflow-traceability", node, ["scripts/check-runner-workflow-traceability.mjs"]),
      ],
    },
    {
      name: "record-finish",
      mode: "serial",
      steps: [cmd("record-build-inputs:finish", node, ["scripts/record-build-inputs.mjs", "--finish"])],
    },
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`[runner:build] unrecognized argument(s): ${unknown.join(" ")}`);
    process.exit(1);
  }
  const phases = buildRunnerBuildPlan();
  if (dryRun) {
    console.log(JSON.stringify({ phases }, null, 2));
    return;
  }
  await executePhases(phases, { prefix: "[runner:build]", verbosePhases: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
