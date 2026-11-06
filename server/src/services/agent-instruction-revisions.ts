import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { createHash } from "node:crypto";
import { adoptAgentFiles, agentFileToken, isAgentFileSaveRecorded } from "./agent-file-store.js";
import { invalidateAgentFileProjection, persistDurableAgentFiles } from "./agent-file-durability.js";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  plugins,
  pluginManagedResources,
  agentInstructionHeads as heads,
  agentInstructionRevisions as revisions,
  fileStorageDb,
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
  db = fileStorageDb(db);
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
      await currentFile(tx, target, state);
      const row = await currentFile(tx, target, { ...state, entryFile: bound.declaredEntryFile });
      return { snapshot: row ? snapshot(await withSaveRecord(tx, row)) : null, configuredEntryFile: state.entryFile };
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
  async function currentFile(tx: Tx, target: InstructionTarget, state: Awaited<ReturnType<typeof lockTarget>>) {
    await adoptAgentFiles(tx, state.agent);
    const bytes = await readInstructionBytes(state.root, state.entryFile);
    if (bytes === null) return null;
    return currentRow(target, state.entryFile, bytes);
  }
  function currentRow(target: InstructionTarget, entryFile: string, bytes: Buffer, actor?: RevisionActor): Revision {
    return { ...target, id: agentFileToken(bytes), entryFile, contentBase64: bytes.toString("base64"),
      contentHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length,
      parentRevisionId: null, baseRevisionId: null, restoredFromRevisionId: null, source: "api",
      ...actorFields(actor), createdAt: new Date(0) };
  }
  function actorFields(actor?: RevisionActor) {
    return {
      actorAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
      actorUserId: actor?.type === "board" ? actor.userId ?? null : null,
      responsibleUserId: actor?.type === "board" ? actor.userId ?? null : actor?.type === "agent" ? actor.onBehalfOfUserId ?? null : null,
      sourceRunId: actor && actor.type !== "plugin" ? actor.runId ?? null : null,
    };
  }
  // Every save writes one `agent.files_updated` row with the path and content
  // hash. Those rows are the instruction history; adoption rows only repair the
  // runtime journal and name nobody as the writer.
  function saveRecords(target: InstructionTarget, entryFile: string) {
    return and(
      eq(activityLog.companyId, target.companyId), eq(activityLog.entityType, "agent"),
      eq(activityLog.entityId, target.agentId), eq(activityLog.action, "agent.files_updated"),
      eq(sql<string>`${activityLog.details}->>'path'`, entryFile),
      sql`${activityLog.details}->>'contentHash' is not null`,
      sql`${activityLog.details}->>'source' is distinct from 'adopted'`,
    );
  }
  type SaveRecord = typeof activityLog.$inferSelect;
  function saveSource(source: unknown): AgentInstructionSource {
    if (source === "legacy_restore") return "restore";
    return source === "board" || source === "api" || source === "tool" || source === "cleanup" ? source : "api";
  }
  function saveRevision(save: SaveRecord, entryFile: string, current: Revision | null): Omit<Revision, "contentBase64"> {
    const contentHash = String(save.details!.contentHash);
    const byteLength = typeof save.details!.byteLength === "number" ? save.details!.byteLength
      : current?.contentHash === contentHash ? current.byteLength : 0;
    return { id: save.id, companyId: save.companyId, agentId: save.entityId, entryFile, contentHash, byteLength,
      parentRevisionId: null, baseRevisionId: null, restoredFromRevisionId: null, source: saveSource(save.details!.source),
      actorAgentId: save.actorType === "agent" ? save.actorId : null,
      actorUserId: save.actorType === "user" ? save.actorId : null,
      responsibleUserId: save.responsibleUserId, sourceRunId: save.runId, createdAt: save.createdAt };
  }
  // The content ETag carries no history. Its writer is the latest save of these
  // exact bytes, never the reader; bytes with no recorded save have no writer.
  async function withSaveRecord(tx: Tx, row: Revision): Promise<Revision> {
    const [saved] = await tx.select().from(activityLog)
      .where(and(saveRecords(row, row.entryFile), eq(sql<string>`${activityLog.details}->>'contentHash'`, row.contentHash)))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
    if (!saved) return row;
    const { id: _saveId, byteLength: _byteLength, ...writer } = saveRevision(saved, row.entryFile, row);
    return { ...row, ...writer, id: row.id, byteLength: row.byteLength };
  }
  // A history ID is a legacy revision, a save record, or the current content
  // ETag. A save's bytes are kept only while they are still current.
  async function resolveRevision(tx: Tx, target: InstructionTarget, entryFile: string, id: string, current: Revision | null): Promise<Revision> {
    const [legacy] = await tx.select().from(revisions).where(and(owner(target, entryFile), eq(revisions.id, id)));
    if (legacy) return legacy;
    if (current && current.entryFile === entryFile && current.id === id) return withSaveRecord(tx, current);
    const [saved] = await tx.select().from(activityLog).where(and(saveRecords(target, entryFile), eq(activityLog.id, id)));
    if (!saved) throw notFound("Instruction revision not found");
    if (!current || current.entryFile !== entryFile || current.contentHash !== saved.details!.contentHash) {
      throw notFound("This save is in the history, but its content is no longer kept. Only the current content can be read.", {
        code: "INSTRUCTION_REVISION_CONTENT_NOT_RETAINED", revisionId: id });
    }
    return { ...saveRevision(saved, entryFile, current), contentBase64: current.contentBase64 };
  }
  async function readCurrent(
    target: InstructionTarget,
    actor: AuthorizationActor,
  ): Promise<AgentInstructionSnapshot | null> {
    return db.transaction(async (tx) => {
      const state = await lockTarget(tx, target, actor);
      await authorizeRead(tx, actor, target);
      const row = await currentFile(tx, target, state);
      return row ? snapshot(await withSaveRecord(tx, row)) : null;
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
      const current = await currentFile(tx, input, state);
      const restored =
        "restoreRevisionId" in input
          ? await resolveRevision(
              tx,
              input,
              input.entryFile,
              input.restoreRevisionId,
              current,
            )
          : null;
      const candidate = bytes ?? Buffer.from(restored!.contentBase64, "base64");
      const writer = actorFields(bound);
      const recordSave = (row: Revision, adopted: boolean) => tx.insert(activityLog).values({ companyId: input.companyId,
        actorType: bound.type === "plugin" ? "plugin" : bound.type === "board" ? "user" : "agent",
        actorId: (bound.type === "plugin" ? bound.pluginId : bound.type === "board" ? bound.userId : bound.agentId)!,
        agentId: bound.type === "agent" ? bound.agentId : null, runId: row.sourceRunId,
        responsibleUserId: row.responsibleUserId, action: "agent.files_updated", entityType: "agent", entityId: input.agentId,
        details: { path: input.entryFile, contentHash: row.contentHash, created: current === null, source: restored ? "legacy_restore" : (input as InstructionCommitInput).source } });
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
        // These bytes predate this call. Record the caller's adoption for the
        // runtime journal, and answer with the bytes' own writer.
        if (!await isAgentFileSaveRecorded(tx, state.agent, input.entryFile, current.contentHash)) await recordSave(current, true);
        await bindEntry();
        return { row: await withSaveRecord(tx, current), changed: false };
      }
      // A pre-upgrade run can still pin a historical UUID, and a history read
      // returns a save record ID. Compare their bytes, never let an old base
      // project over a newer directory.
      const legacyBase = input.baseRevisionId && current?.id !== input.baseRevisionId
        ? await tx.select({ contentHash: revisions.contentHash }).from(revisions).where(and(owner(input, input.entryFile), eq(revisions.id, input.baseRevisionId))).then(rows => rows[0])
          ?? await tx.select({ contentHash: sql<string>`${activityLog.details}->>'contentHash'` }).from(activityLog)
            .where(and(saveRecords(input, input.entryFile), eq(activityLog.id, input.baseRevisionId))).then(rows => rows[0])
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
      await invalidateAgentFileProjection(state.root);
      await materializeInstructionBytes(state.root, state.entryFile, candidate);
      await persistDurableAgentFiles(tx, state.agent, state.root);
      const row = currentRow(input, input.entryFile, candidate, bound);
      row.createdAt = await recordSave(row, false);
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
      await authorizeRead(tx, actor, target);
      const current = await currentFile(tx, target, state);
      const entryFile = instructionPath(target.entryFile);
      // History merges adopted legacy revision rows with the save records that
      // replaced them. Both share one (created_at, id) order.
      const entries = sql`(
        select ${revisions.id} as id, ${revisions.createdAt} as created_at from ${revisions}
          where ${owner(target, entryFile)}
        union all
        select ${activityLog.id} as id, ${activityLog.createdAt} as created_at from ${activityLog}
          where ${saveRecords(target, entryFile)}
      ) entries`;
      if (target.cursor) {
        const [known] = await tx.execute<{ id: string }>(sql`select id from ${entries} where id = ${target.cursor}`);
        if (!known) throw notFound("Instruction revision not found");
      }
      // Keep PostgreSQL timestamp precision; JS Date truncates microseconds and
      // would skip revisions in the cursor's fractional millisecond.
      const page = await tx.execute<{ id: string }>(sql`
        select id from ${entries}
        ${target.cursor ? sql`where (created_at, id) < (select created_at, id from ${entries} where id = ${target.cursor})` : sql``}
        order by created_at desc, id desc limit ${limit + 1}`);
      const ids = Array.from(page, (row) => row.id);
      const legacy = ids.length ? await tx.select(revisionMetadataColumns).from(revisions)
        .where(and(owner(target, entryFile), inArray(revisions.id, ids))) : [];
      const saves = ids.length ? await tx.select().from(activityLog)
        .where(and(saveRecords(target, entryFile), inArray(activityLog.id, ids))) : [];
      const byId = new Map<string, Omit<Revision, "contentBase64">>([
        ...legacy.map((row) => [row.id, row] as const),
        ...saves.map((save) => [save.id, saveRevision(save, entryFile, current)] as const),
      ]);
      const rows = ids.map((id) => byId.get(id)!);
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
      const state = await lockTarget(tx, target, actor);
      await authorizeRead(tx, actor, target);
      return snapshot(
        await resolveRevision(
          tx,
          target,
          instructionPath(target.entryFile),
          target.revisionId,
          await currentFile(tx, target, state),
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
