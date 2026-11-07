import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, globSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeScope, HASHED_INPUTS, markCurrent, processTableRequired, readRustcVersion, RUNNER_PACKAGE } from "./runner-release-crate-cache.mjs";

const directory = `${RUNNER_PACKAGE}/runner/target/debug`;
export const DEBUG_INPUTS = [...HASHED_INPUTS, `${RUNNER_PACKAGE}/package.json`, ".cargo/**", `${RUNNER_PACKAGE}/.cargo/**`,
  `${RUNNER_PACKAGE}/runner/.cargo/**`, "scripts/runner-debug-crate-cache.mjs",
  "scripts/runner-release-crate-cache.mjs"];

// Derive all bin units from Cargo, including automatically discovered targets.
// Refuse an expanded workspace until its library/cache contract is reviewed.
function readMetadata(root) {
  return JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--no-deps",
    "--format-version=1", "--manifest-path", "runner/Cargo.toml"], {
    cwd: path.join(root, RUNNER_PACKAGE), encoding: "utf8",
  }));
}

// The workspace is the Runner crate plus its process-table library, which
// has only a lib target. Any other shape needs this contract reviewed.
const PROCESS_TABLE = "paperclip-process-table";

export function debugContract(root, metadata = readMetadata(root)) {
  const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  const core = packages.filter(pkg => pkg.name === "paperclip-runner-core");
  const others = packages.filter(pkg => pkg.name !== "paperclip-runner-core");
  const libraryOnly = pkg => pkg.name === PROCESS_TABLE
    && pkg.targets.every(target => target.kind.every(kind => kind === "lib"));
  if (core.length !== 1 || others.length > 1 || !others.every(libraryOnly)) {
    throw new Error("Review the debug artifact contract for the changed Runner workspace");
  }
  const withProcessTable = others.length === 1;
  const bins = core[0].targets.filter(target => target.kind.includes("bin")).map(target => target.name).sort();
  if (!bins.includes("paperclip-runnerd")) throw new Error("Missing Runner binary target");
  const fingerprint = `${directory}/.fingerprint/paperclip-runner-core-*`;
  const cachedPaths = [fingerprint, `${directory}/deps/libpaperclip_runner_core-*`,
    `${directory}/deps/paperclip_runner_core-*.d`, ...bins.flatMap(bin => [
      `${directory}/deps/${bin.replaceAll("-", "_")}-*`, `${directory}/${bin}`, `${directory}/${bin}.d`,
    ]), ...(withProcessTable ? [`${directory}/.fingerprint/${PROCESS_TABLE}-*`,
      `${directory}/deps/libpaperclip_process_table-*`, `${directory}/deps/paperclip_process_table-*.d`] : [])];
  const required = [
    { label: "lib fingerprint", glob: `${fingerprint}/lib-paperclip_runner_core` },
    { label: "lib dep-info", glob: `${fingerprint}/dep-lib-paperclip_runner_core` },
    { label: "lib rlib", glob: `${directory}/deps/libpaperclip_runner_core-*.rlib` },
    { label: "lib rmeta", glob: `${directory}/deps/libpaperclip_runner_core-*.rmeta` },
    ...bins.flatMap(bin => [
      { label: `${bin} fingerprint`, glob: `${fingerprint}/bin-${bin}` },
      { label: `${bin} dep-info`, glob: `${fingerprint}/dep-bin-${bin}` },
      { label: `${bin} executable`, glob: `${directory}/deps/${bin.replaceAll("-", "_")}-*`, exclude: /\.(d|dSYM)$/ },
    ]),
    ...(withProcessTable ? processTableRequired(directory) : []),
  ];
  return { bins, cachedPaths, required };
}

export function debugKey(root, env = process.env) {
  const hash = createHash("sha256");
  const files = [...globSync(DEBUG_INPUTS, { cwd: root })].filter(file => statSync(path.join(root, file)).isFile()).sort();
  // Include path names, generated inputs, and local Cargo configuration. A
  // changed compiler flag or target must never reuse an mtime-adjusted unit.
  for (const file of [...files, path.join(env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "config"),
    path.join(env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "config.toml")]) {
    hash.update(file).update("\0").update(existsSync(path.resolve(root, file))
      ? readFileSync(path.resolve(root, file)) : "missing").update("\0");
  }
  const buildEnv = Object.entries(env).filter(([name]) =>
    /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|RUSTUP_TOOLCHAIN|RUST_TARGET_PATH|CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS)$/.test(name)
    || /^CARGO_(BUILD|PROFILE|TARGET|ENCODED)/.test(name)).sort();
  hash.update(JSON.stringify(buildEnv));
  return `runner-debug-crate-v1-${computeScope({ workspace: root,
    rustcVersion: readRustcVersion(env, path.join(root, RUNNER_PACKAGE)) })}-${hash.digest("hex")}`;
}

function main() {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const contract = debugContract(root);
  if (process.argv[2] === "mark-current") {
    console.log(JSON.stringify(markCurrent({ root, ...contract, schema: "paperclip.runner-debug-crate.v1" })));
  } else if (process.argv[2] === "plan") {
    const key = debugKey(root);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `key=${key}\npaths<<CACHE_PATHS\n${contract.cachedPaths.join("\n")}\nCACHE_PATHS\n`);
    console.log(JSON.stringify({ key, paths: contract.cachedPaths }));
  } else throw new Error("usage: runner-debug-crate-cache.mjs <plan|mark-current>");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
