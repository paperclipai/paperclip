import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export type LocalKernelBoot = {
  schema: "paperclip.local_kernel.v1";
  machineHash: string;
  kernelBootId: string;
  processSpace: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{32}$/;
const digest = (parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
function validUuid(value: string): boolean {
  return UUID.test(value) && !/^(0|-)+$/.test(value) && !/^(f|-)+$/.test(value);
}

export function readLocalKernelBoot(value: unknown, processSpace: string | null | undefined): LocalKernelBoot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schema !== "paperclip.local_kernel.v1" || typeof row.machineHash !== "string" || !HASH.test(row.machineHash) || /^(0+|f+)$/.test(row.machineHash)
    || typeof row.kernelBootId !== "string" || !validUuid(row.kernelBootId)
    || row.processSpace !== processSpace || typeof processSpace !== "string" || !HASH.test(processSpace)) return null;
  return { schema: "paperclip.local_kernel.v1", machineHash: row.machineHash,
    kernelBootId: row.kernelBootId, processSpace };
}

export function observeLinuxKernelBoot(processSpace: string, host: string): LocalKernelBoot | null {
  try {
    let runtime: string;
    const options = { encoding: "utf8" as const, timeout: 1_500, maxBuffer: 4_096,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    try {
      runtime = execFileSync("/usr/bin/systemd-detect-virt", ["--container"], options).trim();
    } catch (error) {
      const failure = error as { status?: number; stdout?: string | Buffer };
      if (failure.status !== 1 || String(failure.stdout).trim() !== "none") return null;
      runtime = "none";
    }
    if (runtime !== "none" && runtime !== "wsl") return null;
    const machine = readFileSync("/etc/machine-id", "utf8").trim().toLowerCase();
    if (!HASH.test(machine) || /^(0+|f+)$/.test(machine)) return null;
    let physicalHost: string;
    if (runtime === "wsl") {
      const result = execFileSync("/mnt/c/Windows/System32/reg.exe",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], options);
      physicalHost = /\bMachineGuid\s+REG_SZ\s+([0-9a-f-]+)\s*$/im.exec(result)?.[1]?.toLowerCase() ?? "";
    } else {
      physicalHost = readFileSync("/sys/class/dmi/id/product_uuid", "utf8").trim().toLowerCase();
    }
    if (!validUuid(physicalHost)) return null;
    const kernelBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
    const namespace = readlinkSync("/proc/self/ns/pid");
    if (!host || !validUuid(kernelBootId) || digest([host, kernelBootId, namespace]) !== processSpace) return null;
    return { schema: "paperclip.local_kernel.v1", machineHash: digest(["linux", runtime, host, physicalHost, machine]),
      kernelBootId, processSpace };
  } catch {
    return null;
  }
}

export function localKernelRestarted(oldValue: unknown, oldSpace: string | null | undefined,
  currentValue: unknown, currentSpace: string): boolean {
  const old = readLocalKernelBoot(oldValue, oldSpace), current = readLocalKernelBoot(currentValue, currentSpace);
  return old !== null && current !== null && old.machineHash === current.machineHash
    && old.kernelBootId !== current.kernelBootId;
}