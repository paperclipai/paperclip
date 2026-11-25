import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREP_TEST_FILES = [
  "test/protocol-contract.test.mjs",
  "test/acpx-sidecar-contract.test.mjs",
  "test/acpx-codex-package-contract.test.mjs",
  "test/acpx-model-selection-package-contract.test.mjs",
  "test/acpx-session-carry-forward-package-contract.test.mjs",
  "test/acpx-message-boundaries-package-contract.test.mjs",
  "test/acpx-rich-extensions-package-contract.test.mjs",
  "scripts/candidate-provider-pack.test.mjs",
  "scripts/materialize-pi-distribution.test.mjs",
  "scripts/cursor-provisioner-layout.test.mjs",
  "scripts/release-provider-pack.test.mjs",
  "scripts/antigravity-provider-pack-smoke.test.mjs",
  "scripts/acpx-release-attestations.test.mjs",
  "scripts/provider-pack-runtime-tree.test.mjs",
  "scripts/aws-agentcore-provisioning.test.mjs",
  "scripts/build-verified-provider-entrypoints.test.mjs",
  "scripts/local-provider-smoke-environment.test.mjs",
  "scripts/materialize-opencode-binary.test.mjs",
  "scripts/materialize-kimi-distribution.test.mjs",
  "scripts/provision-kimi-package.test.mjs",
  "scripts/kimi-metadata-probe.test.mjs",
  "scripts/patch-kimi-runtime.test.mjs",
  "test/kimi-installed-runtime.test.mjs",
  "scripts/installed-package-pack.test.mjs",
  "scripts/runner-runtime-dependency-roots.test.mjs",
  "scripts/runner-package-executable.test.mjs",
  "scripts/stage-runner-provider-node.test.mjs",
  "scripts/stage-runner-binary.test.mjs",
  "scripts/build-inputs.test.mjs",
  "scripts/contracts/contract-fingerprints.test.mjs",
  "scripts/provider-pack-executable-shims.test.mjs",
  "scripts/controlled-evals/controller.test.mjs",
  "scripts/controlled-evals/portable.test.mjs",
  "scripts/runner-protocol-testops.test.mjs",
  "scripts/runner-protocol-eval-workflow-security.test.mjs",
  "scripts/build-copilot-distribution.test.mjs",
  "scripts/copilot-inner-distribution.test.mjs",
  "scripts/copilot-smoke-resources.test.mjs",
  "scripts/discover-copilot-acp.test.mjs",
  "scripts/materialize-copilot-binary.test.mjs",
  "scripts/install-copilot-assets.test.mjs",
  "scripts/probe-copilot-acp.test.mjs",
  "scripts/qualify-copilot-acp.test.mjs",
  "scripts/run-check-static.test.mjs",
];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export function planPrepCommands({ skipBuild = false } = {}) {
  return [
    ...(skipBuild
      ? []
      : [
          { command: pnpm, args: ["run", "ensure:eval-build-deps"], cwd: packageRoot },
          { command: pnpm, args: ["run", "build:rust"], cwd: packageRoot },
        ]),
    {
      command: process.execPath,
      args: ["../../scripts/ci-profile/node-test.mjs", ...PREP_TEST_FILES],
      cwd: packageRoot,
    },
  ];
}

function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--skip-build" && arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`[run-prep-tests] unrecognized argument(s): ${unknown.join(" ")}`);
    process.exit(1);
  }
  const planned = planPrepCommands({ skipBuild });
  if (dryRun) {
    console.log(JSON.stringify({ skipBuild, files: PREP_TEST_FILES, planned }, null, 2));
    return;
  }
  for (const step of planned) {
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
