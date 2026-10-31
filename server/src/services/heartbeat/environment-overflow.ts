import { spawn } from "node:child_process";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentCapacity } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";

const ADMISSION_TIMEOUT_MS = 10_000;
const TASKKILL_TIMEOUT_MS = 5_000;

export interface EnvironmentOverflowDeps {
  getEnvironment(id: string): Promise<Environment | null>;
  findAffinityEnvironmentId(candidateIds: string[]): Promise<string | null>;
  countActiveLeases(environmentId: string): Promise<number>;
  admit(command: string[]): Promise<boolean>;
}

function killProcessTree(pid: number) {
  try {
    if (process.platform !== "win32") return void process.kill(-pid, "SIGKILL");
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const bound = setTimeout(() => killer.kill(), TASKKILL_TIMEOUT_MS);
    bound.unref();
    killer.once("error", () => clearTimeout(bound));
    killer.once("close", () => clearTimeout(bound));
  } catch { }
}

export function runAdmissionCommand(command: string[], timeoutMs = ADMISSION_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      killProcessTree(child.pid!);
      resolve(false);
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => {
      clearTimeout(timer);
      killProcessTree(child.pid!);
      resolve(code === 0);
    });
  });
}

export async function selectOverflowEnvironmentId(input: {
  primaryEnvironmentId: string;
  fallbackEnvironmentIds: string[];
}, deps: EnvironmentOverflowDeps): Promise<string | null> {
  const candidateIds = [...new Set([input.primaryEnvironmentId, ...input.fallbackEnvironmentIds])];
  if (candidateIds.length === 1) return input.primaryEnvironmentId;
  const pinned = await deps.findAffinityEnvironmentId(candidateIds);
  for (const id of pinned ? [pinned, ...candidateIds.filter((c) => c !== pinned)] : candidateIds) {
    const environment = await deps.getEnvironment(id);
    if (!environment || environment.status !== "active") continue;
    if (environment.driver !== "local" && environment.driver !== "ssh") continue;
    const capacity = parseObject(parseObject(environment.config).capacity) as EnvironmentCapacity;
    if (capacity.maxConcurrentRuns !== undefined &&
      await deps.countActiveLeases(id) >= capacity.maxConcurrentRuns) continue;
    if (capacity.admissionCommand?.length && !(await deps.admit(capacity.admissionCommand))) continue;
    return id;
  }
  return null;
}

export function environmentOverflowDeps(db: Db, input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  getEnvironment: EnvironmentOverflowDeps["getEnvironment"];
}): EnvironmentOverflowDeps {
  return {
    getEnvironment: input.getEnvironment,
    async findAffinityEnvironmentId(candidateIds) {
      const sameIssueSession = input.issueId
        ? and(eq(environmentLeases.issueId, input.issueId), sql`${environmentLeases.metadata}->>'agentId' = ${input.agentId}`)
        : undefined;
      const [lease] = await db.select({ environmentId: environmentLeases.environmentId })
        .from(environmentLeases)
        .where(and(
          eq(environmentLeases.companyId, input.companyId),
          inArray(environmentLeases.environmentId, candidateIds),
          or(eq(environmentLeases.heartbeatRunId, input.runId), sameIssueSession),
        ))
        .orderBy(desc(sql`${environmentLeases.heartbeatRunId} = ${input.runId}`), desc(environmentLeases.acquiredAt))
        .limit(1);
      return lease?.environmentId ?? null;
    },
    async countActiveLeases(environmentId) {
      const [row] = await db.select({ value: count() }).from(environmentLeases)
        .where(and(eq(environmentLeases.environmentId, environmentId), eq(environmentLeases.status, "active")));
      return Number(row?.value ?? 0);
    },
    admit: (command) => runAdmissionCommand(command),
  };
}
