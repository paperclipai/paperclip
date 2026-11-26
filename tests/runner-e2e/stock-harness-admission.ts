import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
export const STOCK_PREFLIGHT_ENV = "PAPERCLIP_RUNNER_E2E_STOCK_PREFLIGHT";

// An allowlist keeps every provider credential, ambient auth override, and GH
// token out of the prerequisite subprocess, including secrets added later.
export function stockPreflightEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL",
    "CARGO_HOME", "RUSTUP_HOME", "CI", "GITHUB_ACTIONS",
  ].flatMap(name => source[name] === undefined ? [] : [[name, source[name]]]));
}

export function verifyStockHarnessPreflight(receiptPath: string | undefined) {
  if (!receiptPath) throw new Error("Stock harness has no prerequisite receipt; use the live launcher.");
  const run = spawnSync(process.execPath, [path.join(root, "tests/runner-e2e/stock-harness-checks.mjs"), `--verify=${receiptPath}`], {
    cwd: root, env: stockPreflightEnvironment(process.env), encoding: "utf8", timeout: 30_000,
  });
  if (run.status !== 0) throw new Error(`Stock harness prerequisite verification failed: ${run.stderr || run.error?.message || run.status}`);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

export function prepareStockHarnessPreflight(campaignDirectory: string) {
  // The trusted artifact selector admits exactly one campaign root. Keep all
  // prerequisite evidence inside that root, including pre-provider failures.
  const output = path.join(campaignDirectory, "stock-harness-prerequisites", randomUUID());
  const receipt = path.join(output, "preflight.json");
  const run = spawnSync(process.execPath, [path.join(root, "tests/runner-e2e/stock-harness-checks.mjs"),
    `--output-dir=${output}`, ...(process.env.GITHUB_ACTIONS === "true" ? ["--allow-rust-network"] : [])], {
    cwd: root, env: stockPreflightEnvironment(process.env), stdio: "inherit", timeout: 50 * 60_000,
  });
  if (run.status !== 0) throw new Error(`Stock harness prerequisites failed before provider execution. Retained receipt: ${receipt}`);
  verifyStockHarnessPreflight(receipt);
  return receipt;
}
