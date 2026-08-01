import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";

export type RuntimePrimaryLease = {
  pid: number;
  startedAt: string;
  requestedPort: number;
  instanceId?: string | null;
  processStartedAt?: string | null;
};

const DEFAULT_RUNTIME_PRIMARY_LEASE_RELATIVE_PATH = "runtime/runtime-primary-instance.json";
const CURRENT_RUNTIME_PRIMARY_INSTANCE_ID = randomUUID();

function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRuntimePrimaryProcessStartedAt(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return startedAt.length > 0 ? startedAt : null;
  } catch {
    return null;
  }
}

function getCurrentRuntimePrimaryInstanceIdentity() {
  return {
    pid: process.pid,
    instanceId: CURRENT_RUNTIME_PRIMARY_INSTANCE_ID,
    processStartedAt: readRuntimePrimaryProcessStartedAt(process.pid),
  };
}

function doesLeaseMatchRuntimeIdentity(
  lease: RuntimePrimaryLease | null,
  identity: {
    pid: number;
    instanceId?: string | null;
    processStartedAt?: string | null;
  },
) {
  if (!lease || lease.pid !== identity.pid) return false;
  if (lease.instanceId && identity.instanceId) {
    return lease.instanceId === identity.instanceId;
  }
  if (lease.processStartedAt && identity.processStartedAt) {
    return lease.processStartedAt === identity.processStartedAt;
  }
  return false;
}

function isRecordedLeaseOwnerAlive(lease: RuntimePrimaryLease | null) {
  if (!lease || !isPidAlive(lease.pid)) return false;
  if (!lease.processStartedAt) return true;
  const liveProcessStartedAt = readRuntimePrimaryProcessStartedAt(lease.pid);
  if (!liveProcessStartedAt) return true;
  return liveProcessStartedAt === lease.processStartedAt;
}

function isRecycledPidLeaseOwner(
  lease: RuntimePrimaryLease | null,
  identity: {
    pid: number;
    instanceId?: string | null;
  },
) {
  return Boolean(
    lease &&
    lease.pid === identity.pid &&
    lease.instanceId &&
    identity.instanceId &&
    lease.instanceId !== identity.instanceId,
  );
}

export function resolveRuntimePrimaryLeasePath(explicitPath?: string | null) {
  const envPath = explicitPath?.trim() || process.env.PAPERCLIP_RUNTIME_PRIMARY_LEASE_FILE?.trim();
  if (envPath && envPath.length > 0) {
    return envPath;
  }
  return resolve(resolvePaperclipInstanceRoot(), DEFAULT_RUNTIME_PRIMARY_LEASE_RELATIVE_PATH);
}

export function readRuntimePrimaryLease(explicitPath?: string | null): RuntimePrimaryLease | null {
  const leasePath = resolveRuntimePrimaryLeasePath(explicitPath);
  try {
    const parsed = JSON.parse(readFileSync(leasePath, "utf8")) as Partial<RuntimePrimaryLease>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.requestedPort !== "number" ||
      !Number.isInteger(parsed.requestedPort)
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      requestedPort: parsed.requestedPort,
      instanceId: typeof parsed.instanceId === "string" && parsed.instanceId.length > 0
        ? parsed.instanceId
        : null,
      processStartedAt: typeof parsed.processStartedAt === "string" && parsed.processStartedAt.length > 0
        ? parsed.processStartedAt
        : null,
    };
  } catch {
    return null;
  }
}

export function releaseRuntimePrimaryLeaseForPid(
  pid: number,
  explicitPath?: string | null,
) {
  const leasePath = resolveRuntimePrimaryLeasePath(explicitPath);
  const lease = readRuntimePrimaryLease(leasePath);
  const identity = getCurrentRuntimePrimaryInstanceIdentity();
  if (identity.pid !== pid || !doesLeaseMatchRuntimeIdentity(lease, identity)) return false;
  rmSync(leasePath, { force: true });
  return true;
}

export function claimRuntimePrimaryLease(input: {
  pid: number;
  requestedPort: number;
  startedAt?: string;
  explicitPath?: string | null;
  instanceId?: string | null;
  processStartedAt?: string | null;
}) {
  const leasePath = resolveRuntimePrimaryLeasePath(input.explicitPath);
  mkdirSync(dirname(leasePath), { recursive: true });
  const identity = {
    pid: input.pid,
    instanceId: input.instanceId ?? CURRENT_RUNTIME_PRIMARY_INSTANCE_ID,
    processStartedAt: input.processStartedAt ?? readRuntimePrimaryProcessStartedAt(input.pid),
  };
  const lease: RuntimePrimaryLease = {
    pid: input.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    requestedPort: input.requestedPort,
    instanceId: identity.instanceId,
    processStartedAt: identity.processStartedAt,
  };
  const payload = `${JSON.stringify(lease, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(leasePath, "wx");
      try {
        writeFileSync(fd, payload, "utf8");
      } finally {
        closeSync(fd);
      }
      return { acquired: true, leasePath, existing: lease };
    } catch {
      const existing = readRuntimePrimaryLease(leasePath);
      if (doesLeaseMatchRuntimeIdentity(existing, identity)) {
        writeFileSync(leasePath, payload, "utf8");
        return { acquired: true, leasePath, existing };
      }
      if (isRecycledPidLeaseOwner(existing, identity) || !existing || !isRecordedLeaseOwnerAlive(existing)) {
        rmSync(leasePath, { force: true });
        continue;
      }
      return { acquired: false, leasePath, existing };
    }
  }

  return { acquired: false, leasePath, existing: readRuntimePrimaryLease(leasePath) };
}

export function currentRuntimePrimaryLeaseMatches(lease: RuntimePrimaryLease | null) {
  return doesLeaseMatchRuntimeIdentity(lease, getCurrentRuntimePrimaryInstanceIdentity());
}
