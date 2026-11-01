import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectedNativeBootstrap, expectedNativeModuleGuard, KIMI_FAULT_ENTRY, kimiFaultRuntimeContract, validateKimiProviderDeathReceipt } from "./kimi-provider-fault-contract.js";

const bootId = "12345678-1234-1234-1234-123456789abc";
const root = { pid: 21, ppid: 1, startTicks: "100", bootId };
const parent = { pid: 22, ppid: 21, startTicks: "101", bootId };
const target = { pid: 23, ppid: 22, startTicks: "102", bootId };
const binding = { companyId: "company", environmentId: "environment", runId: "run", leaseId: "lease", sandboxId: "sandbox", image: `registry/image@sha256:${"a".repeat(64)}`, remoteCwd: "/workspace" };
const hash = `sha256:${"a".repeat(64)}`;
function receipt() {
  const contract = kimiFaultRuntimeContract("linux-x64");
  return { schema: "paperclip.e2e.kimi-provider-death.v1", binding, runtimeEnvironmentLeaseId: "workspace-id", target, ancestry: [target, parent, root],
    ...contract, entrypointSha256: hash, guardSha256: hash, bootstrapSha256: hash,
    entrypointAttribution: "pinned_native_bootstrap_parent", originalChildArgvAvailable: false, observedChildTitle: "kimi-code",
    signalled: true, signal: "SIGKILL", targetKind: "kimi_native_child", workerSignalled: false };
}

describe("Kimi native child fault contract", () => {
  it("uses compiled production loader, module guard and native bootstrap bytes", () => {
    const contract = kimiFaultRuntimeContract("linux-x64"), distribution = "/tmp/paperclip-acpx-native-test/distribution";
    expect(contract.guardLoaderSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(contract.closureSha256).toMatch(/^[a-f0-9]{64}$/u);
    const bootstrap = expectedNativeBootstrap(distribution, contract.nodeSha256);
    expect(bootstrap).toContain(`const executable="${distribution}/node/bin/node"`);
    expect(bootstrap).toContain(`"${distribution}/${KIMI_FAULT_ENTRY}","acp"`);
    expect(bootstrap).toContain('const childExecutable=process.platform==="linux"?"/proc/self/fd/"+stdio.length:executable');
    expect(expectedNativeModuleGuard(distribution, [{ path: KIMI_FAULT_ENTRY, sha256: "a".repeat(64) }]))
      .toContain(`const digests={"${distribution}/${KIMI_FAULT_ENTRY}":"${"a".repeat(64)}"};`);
    expect(() => expectedNativeBootstrap(distribution, "invalid")).toThrow("node_digest");
  });

  it("accepts the exact child and rejects misleading or incomplete receipts", () => {
    const valid = receipt();
    expect(validateKimiProviderDeathReceipt(valid, binding, root, "workspace-id")).toEqual(valid);
    for (const alteration of [{ workerSignalled: true }, { targetKind: "runnerd" }, { target: root }, { signalled: false },
      { entrypointAttribution: "process_title" }, { originalChildArgvAvailable: true }, { observedChildTitle: "node" },
      { nodeSha256: hash }, { closureSha256: "a".repeat(64) }, { guardLoaderSha256: hash }, { bootstrapSha256: "invalid" },
      { runtimeEnvironmentLeaseId: "foreign" }, { binding: { ...binding, runId: "foreign" } }, { arbitrary: true },
      { ancestry: [target, root] }, { ancestry: [target, { ...parent, startTicks: "" }, root] },
      { ancestry: [target, { ...parent, ppid: 999 }, root] }, { ancestry: [target, parent, { ...root, startTicks: "999" }] },
    ]) expect(() => validateKimiProviderDeathReceipt({ ...valid, ...alteration }, binding, root, "workspace-id")).toThrow();
  });

  it("accepts real observer root diagnostics without accepting changed identity or open receipt rows", () => {
    const valid = receipt(), observedRoot = { ...root, group: root.pid, state: "S" };
    expect(validateKimiProviderDeathReceipt(valid, binding, observedRoot, "workspace-id")).toEqual(valid);
    for (const changed of [{ pid: 999 }, { ppid: 999 }, { startTicks: "999" }, { bootId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }]) {
      expect(() => validateKimiProviderDeathReceipt(valid, binding, { ...observedRoot, ...changed }, "workspace-id")).toThrow("receipt_ancestry");
    }
    expect(() => validateKimiProviderDeathReceipt({ ...valid, ancestry: [target, parent, observedRoot] }, binding, observedRoot, "workspace-id"))
      .toThrow("receipt_ancestry");
  });

  it("calibrates identity negatives and native Linux pidfd without credentials or network", () => {
    const result = spawnSync("/usr/bin/python3", ["-B", fileURLToPath(new URL("./kimi-provider-fault.test.py", import.meta.url))], {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PYTHONDONTWRITEBYTECODE: "1" },
      cwd: dirname(fileURLToPath(import.meta.url)), timeout: 30_000, killSignal: "SIGTERM", maxBuffer: 64 * 1024,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ran 25 tests");
    if (process.platform === "linux") expect(result.stderr).not.toContain("skipped");
    else expect(result.stderr).toContain("skipped=1");
  }, 35_000);
});
