import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolAccessAuditEvents, toolRuntimeSlots } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode, ToolRuntimeSlotStatus } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

const ACTIVE_SLOT_STATUSES: ToolRuntimeSlotStatus[] = ["starting", "running", "idle"];
const DEFAULT_IDLE_TTL_MS = 1_000;
const DEFAULT_STUCK_SLOT_MS = 5 * 60 * 1000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 60_000;
const DEFAULT_RESTART_STORM_WINDOW_MS = 60_000;
const DEFAULT_RESTART_STORM_LIMIT = 3;
const DEFAULT_MAX_COMPANY_SLOTS = 4;
const DEFAULT_MAX_HOST_SLOTS = 16;
const DEFAULT_MAX_LOG_ENTRIES = 50;
const DEFAULT_MAX_LOG_BYTES = 12_000;

export class ToolRuntimeSupervisorError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reasonCode: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ToolRuntimeSupervisorOptions {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
  hostId?: string;
  idleTtlMs?: number;
  stuckSlotMs?: number;
  restartBackoffMs?: number;
  restartBackoffMaxMs?: number;
  restartStormWindowMs?: number;
  restartStormLimit?: number;
  maxCompanySlots?: number;
  maxHostSlots?: number;
  memoryLimitMb?: number | null;
  maxLogEntries?: number;
  maxLogBytes?: number;
  now?: () => Date;
}

export interface ToolRuntimeSlotView {
  id: string;
  companyId: string;
  connectionKey: string;
  providerType: "mcp_stdio_fixture";
  status: ToolRuntimeSlotStatus;
  startedAt: Date | null;
  lastUsedAt: Date | null;
  stoppedAt: Date | null;
  useCount: number;
  metadata: Record<string, unknown>;
}

interface RuntimeSlotHandle {
  slot: ToolRuntimeSlotView;
  metadata: Record<string, unknown>;
  appendLog(stream: "stdout" | "stderr", line: string): void;
}

function numberOption(value: number | undefined, fallback: number, min = 0) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value ?? fallback));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return {};
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function redactLogLine(line: string) {
  return line
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|pk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[REDACTED_VALUE]");
}

function trimLogs(
  logs: Array<Record<string, unknown>>,
  maxEntries: number,
  maxBytes: number,
): Array<Record<string, unknown>> {
  let next = logs.slice(-maxEntries);
  while (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes && next.length > 0) {
    next = next.slice(1);
  }
  return next;
}

function slotView(row: typeof toolRuntimeSlots.$inferSelect): ToolRuntimeSlotView {
  const metadata = asRecord(row.metadata);
  return {
    id: row.id,
    companyId: row.companyId,
    connectionKey: row.slotKey,
    providerType: "mcp_stdio_fixture",
    status: row.status,
    startedAt: row.startedAt,
    lastUsedAt: row.lastUsedAt,
    stoppedAt: row.stoppedAt,
    useCount: numberValue(metadata.useCount),
    metadata,
  };
}

export function createToolRuntimeSupervisor(db: Db, options: ToolRuntimeSupervisorOptions = {}) {
  const deploymentMode = options.deploymentMode ?? "local_trusted";
  const deploymentExposure = options.deploymentExposure ?? "private";
  const trustedLocalStdioRuntimeHost =
    options.trustedLocalStdioRuntimeHost
    ?? process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
    ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
    ?? null;
  const hostId = options.hostId ?? trustedLocalStdioRuntimeHost ?? process.env.HOSTNAME ?? "local-host";
  const idleTtlMs = numberOption(options.idleTtlMs, DEFAULT_IDLE_TTL_MS, 1);
  const stuckSlotMs = numberOption(options.stuckSlotMs, DEFAULT_STUCK_SLOT_MS, 1);
  const restartBackoffMs = numberOption(options.restartBackoffMs, DEFAULT_RESTART_BACKOFF_MS, 0);
  const restartBackoffMaxMs = numberOption(options.restartBackoffMaxMs, DEFAULT_RESTART_BACKOFF_MAX_MS, 0);
  const restartStormWindowMs = numberOption(options.restartStormWindowMs, DEFAULT_RESTART_STORM_WINDOW_MS, 1);
  const restartStormLimit = numberOption(options.restartStormLimit, DEFAULT_RESTART_STORM_LIMIT, 1);
  const maxCompanySlots = numberOption(options.maxCompanySlots, DEFAULT_MAX_COMPANY_SLOTS, 1);
  const maxHostSlots = numberOption(options.maxHostSlots, DEFAULT_MAX_HOST_SLOTS, 1);
  const maxLogEntries = numberOption(options.maxLogEntries, DEFAULT_MAX_LOG_ENTRIES, 1);
  const maxLogBytes = numberOption(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES, 1);
  const memoryLimitMb = options.memoryLimitMb ?? null;
  const now = options.now ?? (() => new Date());

  function assertLocalStdioAvailable() {
    if (deploymentMode === "authenticated" && deploymentExposure === "public" && !trustedLocalStdioRuntimeHost) {
      throw new ToolRuntimeSupervisorError(
        403,
        "Local stdio MCP runtime is unavailable in authenticated public deployments without a trusted runtime host",
        "local_stdio_unavailable_in_public_mode",
        { deploymentMode, deploymentExposure },
      );
    }
  }

  async function writeAudit(input: {
    companyId: string;
    slotId?: string | null;
    runId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
    action: string;
    outcome: "success" | "failure";
    reasonCode?: string | null;
    details?: Record<string, unknown>;
  }) {
    await db.insert(toolAccessAuditEvents).values({
      companyId: input.companyId,
      actorType: input.agentId ? "agent" : "system",
      actorId: input.agentId ?? "tool-runtime-supervisor",
      action: input.action,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      details: {
        slotId: input.slotId ?? null,
        hostId,
        runId: input.runId ?? null,
        issueId: input.issueId ?? null,
        ...input.details,
      },
    });
  }

  async function writeActivity(input: {
    companyId: string;
    slotId: string;
    runId?: string | null;
    agentId?: string | null;
    action: string;
    details?: Record<string, unknown>;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.agentId ? "agent" : "system",
      actorId: input.agentId ?? "tool-runtime-supervisor",
      action: input.action,
      entityType: "tool_runtime_slot",
      entityId: input.slotId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: {
        hostId,
        ...input.details,
      },
    });
  }

  async function stopExpiredIdleSlots(companyId?: string) {
    const rows = companyId
      ? await db
        .select()
        .from(toolRuntimeSlots)
        .where(eq(toolRuntimeSlots.companyId, companyId))
        .orderBy(desc(toolRuntimeSlots.updatedAt))
      : await db
        .select()
        .from(toolRuntimeSlots)
        .orderBy(desc(toolRuntimeSlots.updatedAt));
    const at = now();
    for (const row of rows) {
      if (row.status !== "idle" && row.status !== "running") continue;
      const idleDeadline = row.idleDeadlineAt ?? row.idleExpiresAt;
      if (!idleDeadline || idleDeadline.getTime() > at.getTime()) continue;
      const metadata = {
        ...asRecord(row.metadata),
        stoppedReason: "idle_ttl_expired",
        stoppedAt: at.toISOString(),
      };
      await db
        .update(toolRuntimeSlots)
        .set({
          status: "stopped",
          stoppedAt: at,
          idleDeadlineAt: null,
          idleExpiresAt: null,
          healthStatus: "ok",
          healthMessage: "Stopped after idle TTL.",
          metadata,
          updatedAt: at,
        })
        .where(eq(toolRuntimeSlots.id, row.id));
      await writeAudit({
        companyId: row.companyId,
        slotId: row.id,
        action: "runtime_stopped",
        outcome: "success",
        reasonCode: "idle_ttl_expired",
        details: { slotKey: row.slotKey },
      });
    }
  }

  async function activeRows() {
    await stopExpiredIdleSlots();
    return db
      .select()
      .from(toolRuntimeSlots)
      .where(inArray(toolRuntimeSlots.status, ACTIVE_SLOT_STATUSES));
  }

  async function assertCapacity(input: {
    companyId: string;
    slotKey: string;
    runId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
  }) {
    const rows = await activeRows();
    const companyCount = rows.filter((row) => row.companyId === input.companyId).length;
    const hostCount = rows.filter((row) => stringValue(asRecord(row.metadata).hostId) === hostId).length;
    if (companyCount >= maxCompanySlots || hostCount >= maxHostSlots) {
      const reasonCode = companyCount >= maxCompanySlots ? "runtime_company_capacity_exhausted" : "runtime_host_capacity_exhausted";
      await writeAudit({
        companyId: input.companyId,
        runId: input.runId,
        issueId: input.issueId,
        agentId: input.agentId,
        action: "runtime_deferred",
        outcome: "failure",
        reasonCode,
        details: {
          slotKey: input.slotKey,
          companyCount,
          hostCount,
          maxCompanySlots,
          maxHostSlots,
        },
      });
      throw new ToolRuntimeSupervisorError(
        429,
        "No local stdio runtime capacity is currently available",
        "runtime_capacity_unavailable",
        { reasonCode, companyCount, hostCount, maxCompanySlots, maxHostSlots },
      );
    }
  }

  function assertRestartAllowed(row: typeof toolRuntimeSlots.$inferSelect, metadata: Record<string, unknown>) {
    const at = now();
    const suppressedUntil = dateValue(metadata.restartSuppressedUntil);
    if (suppressedUntil && suppressedUntil.getTime() > at.getTime()) {
      throw new ToolRuntimeSupervisorError(
        429,
        "Runtime restart storm suppression is active",
        "runtime_restart_suppressed",
        { slotId: row.id, suppressedUntil: suppressedUntil.toISOString() },
      );
    }
    const backoffUntil = dateValue(metadata.restartBackoffUntil);
    if (backoffUntil && backoffUntil.getTime() > at.getTime()) {
      throw new ToolRuntimeSupervisorError(
        429,
        "Runtime restart backoff is active",
        "runtime_restart_backoff",
        { slotId: row.id, backoffUntil: backoffUntil.toISOString() },
      );
    }
  }

  function restartMetadata(row: typeof toolRuntimeSlots.$inferSelect, metadata: Record<string, unknown>, reason: string) {
    const at = now();
    const windowStartedAt = dateValue(metadata.restartWindowStartedAt);
    const inSameWindow = windowStartedAt && at.getTime() - windowStartedAt.getTime() <= restartStormWindowMs;
    const restartCount = inSameWindow ? numberValue(metadata.restartCount) + 1 : 1;
    const suppressed = restartCount > restartStormLimit;
    const backoffMs = restartBackoffMs === 0
      ? 0
      : Math.min(restartBackoffMaxMs, restartBackoffMs * (2 ** Math.max(0, restartCount - 1)));
    return {
      ...metadata,
      hostId,
      restartCount,
      restartWindowStartedAt: (inSameWindow ? windowStartedAt : at)?.toISOString(),
      restartBackoffUntil: backoffMs > 0 ? new Date(at.getTime() + backoffMs).toISOString() : null,
      restartSuppressedUntil: suppressed ? new Date(at.getTime() + restartStormWindowMs).toISOString() : null,
      lastRestartAt: at.toISOString(),
      lastRestartReason: reason,
      previousProviderRef: row.providerRef,
    };
  }

  async function startSlot(
    row: typeof toolRuntimeSlots.$inferSelect,
    input: {
      runId?: string | null;
      issueId?: string | null;
      agentId?: string | null;
      reason: string;
      bypassBackoff?: boolean;
    },
  ) {
    const currentMetadata = asRecord(row.metadata);
    const countsAsRestart = input.reason !== "lazy_start";
    if (!input.bypassBackoff && countsAsRestart) assertRestartAllowed(row, currentMetadata);
    const nextMetadata = countsAsRestart
      ? restartMetadata(row, currentMetadata, input.reason)
      : {
        ...currentMetadata,
        hostId,
        lastStartAt: now().toISOString(),
        lastStartReason: input.reason,
        restartBackoffUntil: null,
        restartSuppressedUntil: null,
      };
    if (countsAsRestart && dateValue(nextMetadata.restartSuppressedUntil)) {
      await db
        .update(toolRuntimeSlots)
        .set({
          status: "failed",
          healthStatus: "error",
          healthMessage: "Restart storm suppression is active.",
          lastError: "restart_storm_suppressed",
          metadata: nextMetadata,
          updatedAt: now(),
        })
        .where(eq(toolRuntimeSlots.id, row.id));
      await writeAudit({
        companyId: row.companyId,
        slotId: row.id,
        runId: input.runId,
        issueId: input.issueId,
        agentId: input.agentId,
        action: "runtime_restart_suppressed",
        outcome: "failure",
        reasonCode: "runtime_restart_suppressed",
        details: { slotKey: row.slotKey },
      });
      throw new ToolRuntimeSupervisorError(
        429,
        "Runtime restart storm suppression is active",
        "runtime_restart_suppressed",
        { slotId: row.id, suppressedUntil: nextMetadata.restartSuppressedUntil },
      );
    }
    const at = now();
    const providerRef = `local-stdio:${hostId}:${randomUUID()}`;
    const [started] = await db
      .update(toolRuntimeSlots)
      .set({
        status: "running",
        provider: "paperclip",
        providerRef,
        processId: null,
        healthStatus: "ok",
        healthMessage: "Local stdio runtime is running.",
        startedAt: at,
        lastStartedAt: at,
        stoppedAt: null,
        idleDeadlineAt: null,
        idleExpiresAt: null,
        lastError: null,
        metadata: {
          ...nextMetadata,
          hostId,
          process: {
            simulated: true,
            supervisorPid: process.pid,
            spawnedPid: null,
            providerRef,
            startedAt: at.toISOString(),
          },
          resourceLimits: {
            memoryMb: memoryLimitMb,
            memoryCeilingSupported: process.platform === "linux",
          },
        },
        updatedAt: at,
      })
      .where(eq(toolRuntimeSlots.id, row.id))
      .returning();
    await writeAudit({
      companyId: started.companyId,
      slotId: started.id,
      runId: input.runId,
      issueId: input.issueId,
      agentId: input.agentId,
      action: "runtime_started",
      outcome: "success",
      reasonCode: input.reason,
      details: { slotKey: started.slotKey, providerRef },
    });
    await writeActivity({
      companyId: started.companyId,
      slotId: started.id,
      runId: input.runId,
      agentId: input.agentId,
      action: "tool_runtime_slot.started",
      details: { slotKey: started.slotKey, reason: input.reason },
    });
    return started;
  }

  async function getOrCreateSlot(input: {
    companyId: string;
    applicationId?: string | null;
    connectionId?: string | null;
    connectionKey: string;
    runId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
    commandTemplateKey?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    await stopExpiredIdleSlots(input.companyId);
    const [existing] = await db
      .select()
      .from(toolRuntimeSlots)
      .where(and(eq(toolRuntimeSlots.companyId, input.companyId), eq(toolRuntimeSlots.slotKey, input.connectionKey)))
      .limit(1);
    if (existing) return existing;
    await assertCapacity({
      companyId: input.companyId,
      slotKey: input.connectionKey,
      runId: input.runId,
      issueId: input.issueId,
      agentId: input.agentId,
    });
    const at = now();
    const [created] = await db
      .insert(toolRuntimeSlots)
      .values({
        companyId: input.companyId,
        applicationId: input.applicationId ?? null,
        connectionId: input.connectionId ?? null,
        slotKey: input.connectionKey,
        ownerScopeType: "connection",
        ownerScopeId: input.connectionId ?? input.connectionKey,
        runtimeKind: "local_stdio",
        status: "stopped",
        reuseKey: input.connectionKey,
        provider: "paperclip",
        providerRef: null,
        commandTemplateKey: input.commandTemplateKey ?? "paperclip.local-stdio-fixture",
        healthStatus: "unchecked",
        metadata: {
          fixture: "slow-stateful-stdio",
          hostId,
          useCount: 0,
          counter: 0,
          logs: [],
          ...input.metadata,
        },
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return created;
  }

  async function recoverIfStuck(
    row: typeof toolRuntimeSlots.$inferSelect,
    input: { runId?: string | null; issueId?: string | null; agentId?: string | null },
  ) {
    if (!ACTIVE_SLOT_STATUSES.includes(row.status)) return row;
    const at = now();
    const lastProgressAt = row.lastUsedAt ?? row.startedAt ?? row.updatedAt;
    if (at.getTime() - lastProgressAt.getTime() <= stuckSlotMs) return row;
    const metadata = {
      ...asRecord(row.metadata),
      stuckRecoveries: numberValue(asRecord(row.metadata).stuckRecoveries) + 1,
      lastStuckDetectedAt: at.toISOString(),
    };
    const [failed] = await db
      .update(toolRuntimeSlots)
      .set({
        status: "failed",
        healthStatus: "error",
        healthMessage: "Stuck runtime slot recovered by supervisor.",
        lastError: "stuck_slot_recovered",
        metadata,
        updatedAt: at,
      })
      .where(eq(toolRuntimeSlots.id, row.id))
      .returning();
    await writeAudit({
      companyId: row.companyId,
      slotId: row.id,
      runId: input.runId,
      issueId: input.issueId,
      agentId: input.agentId,
      action: "runtime_stuck_recovered",
      outcome: "success",
      reasonCode: "stuck_slot_recovered",
      details: { slotKey: row.slotKey },
    });
    return startSlot(failed, { ...input, reason: "stuck_slot_recovered", bypassBackoff: true });
  }

  async function ensureRunningSlot(input: {
    companyId: string;
    applicationId?: string | null;
    connectionId?: string | null;
    connectionKey: string;
    runId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
    commandTemplateKey?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    assertLocalStdioAvailable();
    let row = await getOrCreateSlot(input);
    row = await recoverIfStuck(row, input);
    if (row.status === "running" || row.status === "idle") {
      const at = now();
      const metadata = {
        ...asRecord(row.metadata),
        lastLeaseAt: at.toISOString(),
        hostId,
      };
      const [updated] = await db
        .update(toolRuntimeSlots)
        .set({
          status: "running",
          lastUsedAt: at,
          idleDeadlineAt: null,
          idleExpiresAt: null,
          stoppedAt: null,
          healthStatus: "ok",
          healthMessage: "Local stdio runtime is running.",
          metadata,
          updatedAt: at,
        })
        .where(eq(toolRuntimeSlots.id, row.id))
        .returning();
      return updated;
    }
    await assertCapacity({
      companyId: input.companyId,
      slotKey: input.connectionKey,
      runId: input.runId,
      issueId: input.issueId,
      agentId: input.agentId,
    });
    return startSlot(row, { ...input, reason: row.status === "stopped" ? "lazy_start" : "restart_after_failure" });
  }

  async function idleSlot(row: typeof toolRuntimeSlots.$inferSelect, metadata: Record<string, unknown>) {
    const at = now();
    const idleDeadline = new Date(at.getTime() + idleTtlMs);
    const [updated] = await db
      .update(toolRuntimeSlots)
      .set({
        status: "idle",
        lastUsedAt: at,
        idleDeadlineAt: idleDeadline,
        idleExpiresAt: idleDeadline,
        healthStatus: "ok",
        healthMessage: "Local stdio runtime is idle and reusable.",
        metadata: {
          ...metadata,
          hostId,
          useCount: numberValue(metadata.useCount) + 1,
          lastIdleAt: at.toISOString(),
          idleTtlMs,
        },
        updatedAt: at,
      })
      .where(eq(toolRuntimeSlots.id, row.id))
      .returning();
    return updated;
  }

  return {
    async useConnectionSlot<T>(
      input: {
        companyId: string;
        applicationId?: string | null;
        connectionId?: string | null;
        connectionKey: string;
        runId?: string | null;
        issueId?: string | null;
        agentId?: string | null;
        commandTemplateKey?: string | null;
        metadata?: Record<string, unknown>;
      },
      fn: (handle: RuntimeSlotHandle) => Promise<T>,
    ): Promise<T> {
      const row = await ensureRunningSlot(input);
      const metadata = asRecord(row.metadata);
      const handle: RuntimeSlotHandle = {
        slot: slotView(row),
        metadata,
        appendLog(stream, line) {
          const logs = Array.isArray(metadata.logs) ? [...metadata.logs] as Array<Record<string, unknown>> : [];
          logs.push({
            stream,
            line: redactLogLine(line).slice(0, 1_000),
            at: now().toISOString(),
          });
          metadata.logs = trimLogs(logs, maxLogEntries, maxLogBytes);
        },
      };
      try {
        const result = await fn(handle);
        await idleSlot(row, metadata);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const at = now();
        await db
          .update(toolRuntimeSlots)
          .set({
            status: "failed",
            healthStatus: "error",
            healthMessage: "Local stdio runtime failed during execution.",
            lastError: message.slice(0, 500),
            metadata: {
              ...metadata,
              lastFailureAt: at.toISOString(),
            },
            updatedAt: at,
          })
          .where(eq(toolRuntimeSlots.id, row.id));
        await writeAudit({
          companyId: row.companyId,
          slotId: row.id,
          runId: input.runId,
          issueId: input.issueId,
          agentId: input.agentId,
          action: "runtime_failed",
          outcome: "failure",
          reasonCode: "runtime_execution_failed",
          details: { message: message.slice(0, 500), slotKey: row.slotKey },
        });
        throw error;
      }
    },

    async useFixtureSlot<T>(
      input: {
        companyId: string;
        connectionKey: string;
        runId?: string | null;
        issueId?: string | null;
        agentId?: string | null;
      },
      fn: (handle: RuntimeSlotHandle) => Promise<T>,
    ): Promise<T> {
      const row = await ensureRunningSlot({
        ...input,
        commandTemplateKey: "paperclip.slow-stateful-stdio",
      });
      const metadata = asRecord(row.metadata);
      const handle: RuntimeSlotHandle = {
        slot: slotView(row),
        metadata,
        appendLog(stream, line) {
          const logs = Array.isArray(metadata.logs) ? [...metadata.logs] as Array<Record<string, unknown>> : [];
          logs.push({
            stream,
            line: redactLogLine(line).slice(0, 1_000),
            at: now().toISOString(),
          });
          metadata.logs = trimLogs(logs, maxLogEntries, maxLogBytes);
        },
      };
      try {
        const result = await fn(handle);
        await idleSlot(row, metadata);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const at = now();
        await db
          .update(toolRuntimeSlots)
          .set({
            status: "failed",
            healthStatus: "error",
            healthMessage: "Local stdio runtime failed during execution.",
            lastError: message.slice(0, 500),
            metadata: {
              ...metadata,
              lastErrorAt: at.toISOString(),
            },
            updatedAt: at,
          })
          .where(eq(toolRuntimeSlots.id, row.id));
        throw error;
      }
    },

    async listSlots(companyId?: string): Promise<ToolRuntimeSlotView[]> {
      await stopExpiredIdleSlots(companyId);
      const rows = companyId
        ? await db
          .select()
          .from(toolRuntimeSlots)
          .where(eq(toolRuntimeSlots.companyId, companyId))
          .orderBy(desc(toolRuntimeSlots.updatedAt))
        : await db
          .select()
          .from(toolRuntimeSlots)
          .orderBy(desc(toolRuntimeSlots.updatedAt));
      return rows
        .filter((row) => ACTIVE_SLOT_STATUSES.includes(row.status))
        .map(slotView);
    },

    async stopSlot(input: {
      companyId: string;
      slotId: string;
      runId?: string | null;
      agentId?: string | null;
      reason?: string;
    }): Promise<ToolRuntimeSlotView> {
      const [row] = await db
        .select()
        .from(toolRuntimeSlots)
        .where(and(eq(toolRuntimeSlots.companyId, input.companyId), eq(toolRuntimeSlots.id, input.slotId)))
        .limit(1);
      if (!row) {
        throw new ToolRuntimeSupervisorError(404, "Runtime slot not found", "runtime_slot_not_found", { slotId: input.slotId });
      }
      if (row.runtimeKind !== "local_stdio") {
        throw new ToolRuntimeSupervisorError(
          422,
          "Runtime slot control is only supported for local stdio slots",
          "runtime_control_unsupported",
          { slotId: row.id, runtimeKind: row.runtimeKind },
        );
      }
      const at = now();
      const [stopped] = await db
        .update(toolRuntimeSlots)
        .set({
          status: "stopped",
          stoppedAt: at,
          idleDeadlineAt: null,
          idleExpiresAt: null,
          healthStatus: "ok",
          healthMessage: "Runtime slot stopped.",
          metadata: {
            ...asRecord(row.metadata),
            stoppedReason: input.reason ?? "explicit_stop",
            stoppedAt: at.toISOString(),
          },
          updatedAt: at,
        })
        .where(eq(toolRuntimeSlots.id, row.id))
        .returning();
      await writeAudit({
        companyId: input.companyId,
        slotId: row.id,
        runId: input.runId,
        agentId: input.agentId,
        action: "runtime_stopped",
        outcome: "success",
        reasonCode: input.reason ?? "explicit_stop",
        details: { slotKey: row.slotKey },
      });
      await writeActivity({
        companyId: input.companyId,
        slotId: row.id,
        runId: input.runId,
        agentId: input.agentId,
        action: "tool_runtime_slot.stopped",
        details: { slotKey: row.slotKey, reason: input.reason ?? "explicit_stop" },
      });
      return slotView(stopped);
    },

    async restartSlot(input: {
      companyId: string;
      slotId: string;
      runId?: string | null;
      agentId?: string | null;
    }): Promise<ToolRuntimeSlotView> {
      assertLocalStdioAvailable();
      const [row] = await db
        .select()
        .from(toolRuntimeSlots)
        .where(and(eq(toolRuntimeSlots.companyId, input.companyId), eq(toolRuntimeSlots.id, input.slotId)))
        .limit(1);
      if (!row) {
        throw new ToolRuntimeSupervisorError(404, "Runtime slot not found", "runtime_slot_not_found", { slotId: input.slotId });
      }
      if (row.runtimeKind !== "local_stdio") {
        throw new ToolRuntimeSupervisorError(
          422,
          "Runtime slot control is only supported for local stdio slots",
          "runtime_control_unsupported",
          { slotId: row.id, runtimeKind: row.runtimeKind },
        );
      }
      const at = now();
      const [stoppedRow] = await db
        .update(toolRuntimeSlots)
        .set({
          status: "stopped",
          stoppedAt: at,
          idleDeadlineAt: null,
          idleExpiresAt: null,
          healthStatus: "ok",
          healthMessage: "Runtime slot stopped for restart.",
          metadata: {
            ...asRecord(row.metadata),
            stoppedReason: "explicit_restart",
            stoppedAt: at.toISOString(),
          },
          updatedAt: at,
        })
        .where(eq(toolRuntimeSlots.id, row.id))
        .returning();
      await writeAudit({
        companyId: input.companyId,
        slotId: row.id,
        runId: input.runId,
        agentId: input.agentId,
        action: "runtime_stopped",
        outcome: "success",
        reasonCode: "explicit_restart",
        details: { slotKey: row.slotKey },
      });
      const started = await startSlot(stoppedRow, { ...input, reason: "explicit_restart" });
      return slotView(started);
    },
  };
}

export type ToolRuntimeSupervisor = ReturnType<typeof createToolRuntimeSupervisor>;
