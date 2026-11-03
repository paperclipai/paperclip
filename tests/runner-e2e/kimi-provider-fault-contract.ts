import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256, KIMI_NODE_DISTRIBUTIONS } from "../../packages/paperclip-runner/src/drivers/acpx/kimi-closure-pins.js";
import type { RemoteNativeBinding, RemoteProcessIdentity } from "./remote-native-fixtures.js";

export const KIMI_FAULT_ENTRY = "node_modules/@moonshot-ai/kimi-code/dist/main.mjs";
export const KIMI_FAULT_SNAPSHOT = "/__paperclip_kimi_fault_snapshot__/distribution";
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const requireValue = (value: unknown, code: string): void => { if (!value) throw new Error(`kimi_provider_fault:${code}`); };

function compiledBuilders() {
  const path = new URL("../../packages/paperclip-runner/dist/cli/acpx-runtime-sidecar.cjs", import.meta.url);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let source: string;
  try {
    const before = fstatSync(fd, { bigint: true });
    requireValue(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 16n * 1024n * 1024n, "compiled_sidecar_shape");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    requireValue(BigInt(bytes.length) === before.size && before.size === after.size && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs && before.dev === named.dev && before.ino === named.ino && !named.isSymbolicLink(), "compiled_sidecar_changed");
    source = bytes.toString("utf8");
  } finally { closeSync(fd); }
  const declarations: string[] = [];
  for (const name of ["COMMAND_SOURCE_FD", "COMMAND_DIRECTORY_FD", "DEPENDENCY_ANCESTOR_FD_START", "MAX_DEPENDENCY_ANCESTORS", "MAX_AGENT_COMMAND_BYTES", "VERIFIED_PROVIDER_RUNTIME_TARGET_ENV", "ACPX_PRIVATE_SNAPSHOT_ENV"]) {
    const found = [...source.matchAll(new RegExp(`^var ${name} = ([^\\n]+);$`, "gm"))];
    requireValue(found.length === 1 && /^(?:[0-9 *+()]+|"[A-Z0-9_]+")$/u.test(found[0]![1]!), "compiled_constant");
    declarations.push(found[0]![0]);
  }
  for (const name of ["snapshotBootstrap", "reapCurrentProviderProcessGroup", "guardSnapshotModuleLookup", "guardSnapshotModuleResolution", "snapshotDescriptorAncestorIndex", "snapshotDescriptorResolution", "nativeBootstrap", "nativeModuleGuard"]) {
    const found = [...source.matchAll(new RegExp(`^function ${name}\\([^]*?^}`, "gm"))];
    requireValue(found.length === 1, "compiled_function");
    declarations.push(found[0]![0]);
  }
  return runInNewContext(`${declarations.join("\n")}\n({loader:snapshotBootstrap("commonjs",true),nativeBootstrap,nativeModuleGuard})`, Object.create(null), { timeout: 1000 }) as {
    loader: string; nativeBootstrap(executable: string, digest: string, args: string[]): string;
    nativeModuleGuard(digests: Record<string, string>): string;
  };
}

export function kimiFaultRuntimeContract(target: keyof typeof KIMI_DISTRIBUTION_CLOSURE_SHA256) {
  const loader = compiledBuilders().loader;
  requireValue(typeof loader === "string" && Buffer.byteLength(loader) > 0 && Buffer.byteLength(loader) <= 65536, "compiled_loader");
  return { guardLoaderSha256: sha(loader), closureSha256: KIMI_DISTRIBUTION_CLOSURE_SHA256[target],
    nodeSha256: `sha256:${KIMI_NODE_DISTRIBUTIONS[target].executableSha256}` };
}

export function expectedNativeBootstrap(distribution: string, nodeSha256: string): string {
  const digest = nodeSha256.replace(/^sha256:/u, "");
  requireValue(/^[a-f0-9]{64}$/u.test(digest), "node_digest");
  return compiledBuilders().nativeBootstrap(`${distribution}/node/bin/node`, digest,
    ["--require", `${distribution}/.paperclip-native-module-guard.cjs`, `${distribution}/${KIMI_FAULT_ENTRY}`, "acp"]);
}

export function expectedNativeModuleGuard(distribution: string, entries: readonly { path: string; sha256: string }[]): string {
  return compiledBuilders().nativeModuleGuard(Object.fromEntries(entries.map(entry => [`${distribution}/${entry.path}`, entry.sha256])));
}

export interface KimiProviderDeathReceipt {
  schema: "paperclip.e2e.kimi-provider-death.v1"; binding: RemoteNativeBinding; runtimeEnvironmentLeaseId: string;
  target: RemoteProcessIdentity; ancestry: RemoteProcessIdentity[]; nodeSha256: string; entrypointSha256: string; closureSha256: string;
  guardLoaderSha256: string; guardSha256: string; bootstrapSha256: string;
  entrypointAttribution: "pinned_native_bootstrap_parent"; originalChildArgvAvailable: false; observedChildTitle: "kimi-code";
  signalled: true; signal: "SIGKILL"; targetKind: "kimi_native_child"; workerSignalled: false;
}

export function validateKimiProviderDeathReceipt(value: unknown, binding: RemoteNativeBinding, root: RemoteProcessIdentity, lease: string): KimiProviderDeathReceipt {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "receipt_shape");
  const row = value as Record<string, unknown>, target = row.target as RemoteProcessIdentity;
  const contract = kimiFaultRuntimeContract("linux-x64");
  const keys = ["schema", "binding", "runtimeEnvironmentLeaseId", "target", "ancestry", "nodeSha256", "entrypointSha256", "closureSha256", "guardLoaderSha256", "guardSha256", "bootstrapSha256", "entrypointAttribution", "originalChildArgvAvailable", "observedChildTitle", "signalled", "signal", "targetKind", "workerSignalled"];
  requireValue(Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key))
    && row.schema === "paperclip.e2e.kimi-provider-death.v1" && JSON.stringify(row.binding) === JSON.stringify(binding)
    && row.runtimeEnvironmentLeaseId === lease && row.nodeSha256 === contract.nodeSha256 && row.closureSha256 === contract.closureSha256
    && row.guardLoaderSha256 === contract.guardLoaderSha256 && [row.entrypointSha256, row.guardSha256, row.bootstrapSha256].every(value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value))
    && row.entrypointAttribution === "pinned_native_bootstrap_parent" && row.originalChildArgvAvailable === false && row.observedChildTitle === "kimi-code"
    && row.signalled === true && row.signal === "SIGKILL" && row.targetKind === "kimi_native_child" && row.workerSignalled === false, "receipt_identity");
  const ancestry = row.ancestry as RemoteProcessIdentity[];
  requireValue(target && Array.isArray(ancestry) && ancestry.length >= 3 && ancestry.length <= 64
    && new Set(ancestry.map(process => process?.pid)).size === ancestry.length
    && ancestry.every(process => process && Object.keys(process).sort().join(",") === "bootId,pid,ppid,startTicks"
      && Number.isSafeInteger(process.pid) && process.pid > 1 && Number.isSafeInteger(process.ppid) && process.ppid > 0
      && typeof process.startTicks === "string" && /^[0-9]+$/u.test(process.startTicks) && process.bootId === root.bootId)
    && JSON.stringify(ancestry[0]) === JSON.stringify(target)
    && ["pid", "ppid", "startTicks", "bootId"].every(key => (ancestry.at(-1) as unknown as Record<string, unknown>)?.[key] === (root as unknown as Record<string, unknown>)[key])
    && ancestry.slice(0, -1).every((process, index) => process.ppid === ancestry[index + 1]!.pid) && target.pid !== root.pid, "receipt_ancestry");
  return value as KimiProviderDeathReceipt;
}
