import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { createHash } from "node:crypto";
import { adoptAgentFiles, agentFileToken } from "./agent-file-store.js";
import { and, desc, eq, getTableColumns, lt, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  plugins,
  pluginManagedResources,
  agentInstructionHeads as heads,
  agentInstructionRevisions as revisions,
  type Db,
} from "@paperclipai/db";
import type {
  AgentInstructionCommitReceipt,
  AgentInstructionDiff,
  AgentInstructionHistory,
  AgentInstructionSnapshot,
  AgentInstructionSource,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  agentInstructionsBundleMode,
  deriveBundleState,
  resolveManagedInstructionsRoot,
} from "./agent-instructions.js";
import {
  instructionBytes,
  instructionPath,
  assertInstructionPathSafe,
  readInstructionBytes,
  materializeInstructionBytes,
} from "./agent-instruction-files.js";
import {
  authorizeInstructionCommit,
  authorizeInstructionRead,
} from "./agent-instruction-authorization.js";
import type { AuthorizationActor } from "./authorization.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Revision = typeof revisions.$inferSelect;
type PluginResetActor = { type: "plugin"; pluginId: string; pluginKey: string; agentKey: string };
type RevisionActor = AuthorizationActor | PluginResetActor;
const { contentBase64: _contentColumn, ...revisionMetadataColumns } =
  getTableColumns(revisions);
export type InstructionTarget = { companyId: string; agentId: string };
export type InstructionCommitInput = InstructionTarget & {
  entryFile: string;
  content: string | Uint8Array;
  baseRevisionId: string | null;
  source: Exclude<AgentInstructionSource, "seed" | "restore">;
};
function metadata(row: Omit<Revision, "contentBase64">) {
  const { createdAt, source, ...fields } = row;
  return {
    ...fields,
    source: source as AgentInstructionSource,
    createdAt: createdAt.toISOString(),
  };
}
function snapshot(row: Revision): AgentInstructionSnapshot {
  const { contentBase64, ...fields } = row;
  return {
    revision: metadata(fields),
    content: Buffer.from(contentBase64, "base64").toString("utf8"),
  };
}
function owner(target: InstructionTarget, entryFile: string) {
  return and(
    eq(revisions.companyId, target.companyId),
    eq(revisions.agentId, target.agentId),
    eq(revisions.entryFile, entryFile),
  );
}
function headOwner(target: InstructionTarget, entryFile: string) {
  return and(
    eq(heads.companyId, target.companyId),
    eq(heads.agentId, target.agentId),
    eq(heads.entryFile, entryFile),
  );
}

export function agentInstructionRevisionService(db: Db) {
  async function lockTarget(
    tx: Tx,
    target: InstructionTarget,
    actor?: AuthorizationActor,
  ) {
    if (actor?.type === "agent" && actor.companyId !== target.companyId)
      throw notFound("Agent not found");
    const [agent] = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, target.agentId),
          eq(agents.companyId, target.companyId),
        ),
      )
      .for("update");
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) === "external") {
      throw unprocessable(
        "External host instructions do not support revision write-back. Ask an instance administrator to migrate this bundle to managed storage.",
        { code: "INSTRUCTION_MANAGED_BUNDLE_REQUIRED" },
      );
    }
    const state = deriveBundleState(agent);
    const entryFile = instructionPath(state.entryFile);
    return { agent, entryFile, root: resolveManagedInstructionsRoot(agent) };
  }
  async function authorizeRead(
    tx: Tx,
    actor: AuthorizationActor,
    target: InstructionTarget,
  ) {
    return authorizeInstructionRead(tx, actor, { companyId: target.companyId, id: target.agentId });
  }
  // Trusted host-only reset authority. No HTTP or agent tool accepts this actor.
  async function authorizePluginReset(tx: Tx, actor: PluginResetActor, target: InstructionTarget, agent: typeof agents.$inferSelect) {
    const [plugin] = await tx.select().from(plugins).where(and(eq(plugins.id, actor.pluginId), eq(plugins.pluginKey, actor.pluginKey)));
    const marker = agent.metadata?.paperclipManagedResource as Record<string, unknown> | undefined;
    const [binding] = await tx.select().from(pluginManagedResources).where(and(
      eq(pluginManagedResources.pluginId, actor.pluginId), eq(pluginManagedResources.pluginKey, actor.pluginKey),
      eq(pluginManagedResources.companyId, target.companyId), eq(pluginManagedResources.resourceKind, "agent"),
      eq(pluginManagedResources.resourceKey, actor.agentKey), eq(pluginManagedResources.resourceId, target.agentId),
    ));
    if (!plugin || plugin.status !== "ready" || !plugin.manifestJson.capabilities.includes("agents.managed")
      || !plugin.manifestJson.agents?.some((declaration) => declaration.agentKey === actor.agentKey)
      || !binding || marker?.pluginId !== actor.pluginId || marker.pluginKey !== actor.pluginKey
      || marker.resourceKind !== "agent" || marker.resourceKey !== actor.agentKey) {
      throw forbidden("Plugin reset is limited to its declared, bound managed agent");
    }
    const declared = plugin.manifestJson.agents!.find((declaration) => declaration.agentKey === actor.agentKey)!;
    return { ...actor, declaredEntryFile: instructionPath(declared.instructions?.entryFile ?? "AGENTS.md") };
  }
  async function readForPluginReset(target: InstructionTarget, actor: PluginResetActor) {
    return db.transaction(async (tx) => {
      const state = await lockTarget(tx, target);
      const bound = await authorizePluginReset(tx, actor, target, state.agent);
      // Preserve the formerly configured entry before an explicit stock reset.
      await currentFile(tx, target, state, bound);
      const row = await currentFile(tx, target, { ...state, entryFile: bound.declaredEntryFile }, bound);
      return { snapshot: row ? snapshot(row) : null, configuredEntryFile: state.entryFile };
    });
  }
  async function head(tx: Tx, target: InstructionTarget, entryFile: string) {
    const [result] = await tx
      .select({ revision: revisions })
      .from(heads)
      .innerJoin(revisions, eq(revisions.id, heads.revisionId))
      .where(headOwner(target, entryFile));
    return result?.revision ?? null;
  }
  // The deployed revision tables are read-only upgrade input. Current bytes
  // live in the agent directory; old UUID clients receive a content ETag.
  async function currentFile(tx: Tx, target: InstructionTarget, state: Awaited<ReturnType<typeof lockTarget>>, actor?: RevisionActor) {
    await adoptAgentFiles(tx, state.agent);
    const bytes = await readInstructionBytes(state.root, state.entryFile);
    if (bytes === null) return null;
    return currentRow(target, state.entryFile, bytes, actor);
  }
  function currentRow(target: InstructionTarget, entryFile: string, bytes: Buffer, actor?: RevisionActor): Revision {
    return { ...target, id: agentFileToken(bytes), entryFile, contentBase64: bytes.toString("base64"),
      contentHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length,
      parentRevisionId: null, baseRevisionId: null, restoredFromRevisionId: null, source: "api",
      actorAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
      actorUserId: actor?.type === "board" ? actor.userId ?? null : null,
      responsibleUserId: actor?.type === "board" ? actor.userId ?? null : actor?.type === "agent" ? actor.onBehalfOfUserId ?? null : null,
      sourceRunId: actor && actor.type !== "plugin" ? actor.runId ?? null : null, createdAt: new Date(0) };
  }
  async function getRevision(
    tx: Tx,
    target: InstructionTarget,
    entryFile: string,
    id: string,
  ) {
    const [row] = await tx
      .select()
      .from(revisions)
      .where(and(owner(target, entryFile), eq(revisions.id, id)));
    if (!row) throw notFound("Instruction revision not found");
    return row;
  }
  async function readCurrent(
    target: InstructionTarget,
    actor: AuthorizationActor,
  ): Promise<AgentInstructionSnapshot | null> {
    return db.transaction(async (tx) => {
      const state = await lockTarget(tx, target, actor);
      const bound = await authorizeRead(tx, actor, target);
      const row = await currentFile(tx, target, state, bound);
      return row ? snapshot(row) : null;
    });
  }
  /** Trusted orchestration read for the already authorized run target. This
   * never seeds or writes, and is not exposed through HTTP or model tools. */
  async function readCommittedForRuntime(target: InstructionTarget): Promise<AgentInstructionSnapshot | null> {
    return db.transaction(async (tx) => {
      const state = await lockTarget(tx, target);
      const current = await currentFile(tx, target, state);
      return current ? snapshot(current) : null;
    });
  }
  /** Rebuild disk from the current committed head under the same lock as commits. Safe after restart. */
  async function materializeCurrent(target: InstructionTarget): Promise<void> {
    await db.transaction(async (tx) => {
      const state = await lockTarget(tx, target);
      await adoptAgentFiles(tx, state.agent);
    });
  }
  async function commitInternal(
    input:
      | InstructionCommitInput
      | (Omit<InstructionCommitInput, "content" | "source"> & {
          restoreRevisionId: string;
        }),
    actor: RevisionActor,
    configuredEntryFile?: string,
  ): Promise<AgentInstructionCommitReceipt> {
    instructionPath(input.entryFile);
    const bytes = "content" in input ? instructionBytes(input.content) : null;
    const result = await db.transaction(async (tx) => {
      const state = await lockTarget(tx, input, actor.type === "plugin" ? undefined : actor);
      const bound = actor.type === "plugin"
        ? await authorizePluginReset(tx, actor, input, state.agent)
        : await authorizeInstructionCommit(tx, actor, state.agent);
      if (bound.type === "plugin") {
        if (input.entryFile !== bound.declaredEntryFile) throw forbidden("Plugin reset must restore its declared entry file");
        if (configuredEntryFile !== state.entryFile) throw conflict("Configured instruction entry changed; read the current entry and retry", { code: "INSTRUCTION_ENTRY_CHANGED", entryFile: state.entryFile });
        state.entryFile = input.entryFile;
      }
      if (state.entryFile !== input.entryFile)
        throw conflict(
          "Configured instruction entry changed; read the current entry and retry",
          { code: "INSTRUCTION_ENTRY_CHANGED", entryFile: state.entryFile },
        );
      await assertInstructionPathSafe(state.root, state.entryFile);
      const current = await currentFile(tx, input, state, bound);
      const restored =
        "restoreRevisionId" in input
          ? await getRevision(
              tx,
              input,
              input.entryFile,
              input.restoreRevisionId,
            )
          : null;
      const candidate = bytes ?? Buffer.from(restored!.contentBase64, "base64");
      const bindEntry = async () => {
        if (
          !state.agent.adapterConfig.instructionsRootPath ||
          !state.agent.adapterConfig.instructionsBundleMode ||
          (bound.type === "plugin" && configuredEntryFile !== input.entryFile)
        ) {
          await updateAgentConfigurationInTransaction(tx as unknown as Db, state.agent.id, {
            adapterConfig: {
              ...state.agent.adapterConfig,
              instructionsBundleMode: "managed",
              instructionsRootPath: state.root,
              instructionsEntryFile: state.entryFile,
              instructionsFilePath: `${state.root}/${state.entryFile}`,
            },
          }, { allowPendingApprovalConfigUpdate: true });
        }
      };
      // An exact replay can safely return the durable receipt even after its base
      // advanced. Restore also deduplicates identical content, preserving history.
      if (current && current.contentBase64 === candidate.toString("base64")) {
        await bindEntry();
        return { row: current, changed: false };
      }
      // A pre-upgrade run can still pin a historical UUID. Compare its bytes,
      // never let the old head project over a newer directory.
      const legacyBase = input.baseRevisionId && current?.id !== input.baseRevisionId
        ? await tx.select().from(revisions).where(and(owner(input, input.entryFile), eq(revisions.id, input.baseRevisionId))).then(rows => rows[0])
        : null;
      if ((current?.id ?? null) !== input.baseRevisionId && !(legacyBase && legacyBase.contentHash === current?.contentHash)) {
        throw conflict(
          "Instructions changed since the base revision. Read the current entry before saving.",
          {
            code: "INSTRUCTION_REVISION_CONFLICT",
            baseRevisionId: input.baseRevisionId,
            currentRevisionId: current?.id ?? null,
          },
        );
      }
      await materializeInstructionBytes(state.root, state.entryFile, candidate);
      const row = currentRow(input, input.entryFile, candidate, bound);
      await tx.insert(activityLog).values({ companyId: input.companyId,
        actorType: bound.type === "plugin" ? "plugin" : bound.type === "board" ? "user" : "agent",
        actorId: (bound.type === "plugin" ? bound.pluginId : bound.type === "board" ? bound.userId : bound.agentId)!,
        agentId: bound.type === "agent" ? bound.agentId : null, runId: row.sourceRunId,
        responsibleUserId: row.responsibleUserId, action: "agent.files_updated", entityType: "agent", entityId: input.agentId,
        details: { path: input.entryFile, contentHash: row.contentHash, source: restored ? "legacy_restore" : (input as InstructionCommitInput).source } });
      await bindEntry();
      return { row, changed: true };
    });
    return { ...snapshot(result.row), changed: result.changed, materialization: "current" };
  }

  async function history(
    target: InstructionTarget & {
      entryFile: string;
      cursor?: string;
      limit?: number;
    },
    actor: AuthorizationActor,
  ): Promise<AgentInstructionHistory> {
    const limit = Math.max(1, Math.min(100, target.limit ?? 50));
    return db.transaction(async (tx) => {
      const state = await lockTarget(tx, target, actor);
      const bound = await authorizeRead(tx, actor, target);
      await currentFile(tx, target, state, bound);
      instructionPath(target.entryFile);
      const cursor = target.cursor
        ? await getRevision(tx, target, target.entryFile, target.cursor)
        : null;
      // Keep PostgreSQL timestamp precision; JS Date truncates microseconds and
      // would skip revisions in the cursor's fractional millisecond.
      const cursorTime = cursor
        ? sql`(select created_at from agent_instruction_revisions where id = ${cursor.id})`
        : null;
      const rows = await tx
        .select(revisionMetadataColumns)
        .from(revisions)
        .where(
          and(
            owner(target, target.entryFile),
            cursor && cursorTime
              ? or(
                  lt(revisions.createdAt, cursorTime),
                  and(
                    eq(revisions.createdAt, cursorTime),
                    lt(revisions.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(revisions.createdAt), desc(revisions.id))
        .limit(limit + 1);
      return {
        revisions: rows.slice(0, limit).map(metadata),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    });
  }
  async function readRevision(
    target: InstructionTarget & { entryFile: string; revisionId: string },
    actor: AuthorizationActor,
  ) {
    return db.transaction(async (tx) => {
      await lockTarget(tx, target, actor);
      await authorizeRead(tx, actor, target);
      return snapshot(
        await getRevision(
          tx,
          target,
          instructionPath(target.entryFile),
          target.revisionId,
        ),
      );
    });
  }
  async function diff(
    target: InstructionTarget & {
      entryFile: string;
      fromRevisionId: string;
      toRevisionId: string;
    },
    actor: AuthorizationActor,
  ): Promise<AgentInstructionDiff> {
    const from = await readRevision(
      { ...target, revisionId: target.fromRevisionId },
      actor,
    );
    const to = await readRevision(
      { ...target, revisionId: target.toRevisionId },
      actor,
    );
    // Linear, bounded exact replacement diff. Code points keep surrogate pairs intact.
    const a = Array.from(from.content),
      b = Array.from(to.content);
    let start = 0,
      end = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
      start++;
    while (
      end < a.length - start &&
      end < b.length - start &&
      a[a.length - end - 1] === b[b.length - end - 1]
    )
      end++;
    return {
      from,
      to,
      prefix: a.slice(0, start).join(""),
      removed: a.slice(start, a.length - end).join(""),
      added: b.slice(start, b.length - end).join(""),
      suffix: end ? a.slice(-end).join("") : "",
    };
  }
  return {
    readCommittedForRuntime,
    readCurrent,
    readForPluginReset,
    commitPluginReset: (input: Omit<InstructionCommitInput, "source"> & { configuredEntryFile: string }, actor: PluginResetActor) =>
      commitInternal({ ...input, source: "api" }, actor, input.configuredEntryFile),
    readRevision,
    history,
    diff,
    materializeCurrent,
    commit: (input: InstructionCommitInput, actor: AuthorizationActor) =>
      commitInternal(input, actor),
    restore: (
      input: InstructionTarget & {
        entryFile: string;
        baseRevisionId: string;
        revisionId: string;
      },
      actor: AuthorizationActor,
    ) =>
      commitInternal({ ...input, restoreRevisionId: input.revisionId }, actor),
  };
}
