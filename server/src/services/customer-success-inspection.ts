import fs from "node:fs/promises";
import { constants } from "node:fs";
import { and, eq, getTableColumns, type SQL } from "drizzle-orm";
import type { AnyPgTable, AnyPgColumn } from "drizzle-orm/pg-core";
import * as schema from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  MAX_INSPECTION_BYTES,
  type InspectionQuery,
  type InspectionResource,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { redactAgentAdapterConfig, redactEventPayload } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import {
  assertWorkspaceFilePathAllowed,
  workspaceFileResourceService,
} from "./workspace-file-resources.js";
import { deriveBundleState } from "./agent-instructions.js";
import { readInstructionBytes } from "./agent-instruction-files.js";
import { getRunLogStore } from "./run-log-store.js";

// This is a reviewed catalog of readers, not a proxy for existing GET routes.
// Select credentials out of queries; never load encrypted identity records.
interface Reader {
  table: AnyPgTable;
  omit?: string[];
  parent?: string;
  id?: string;
}
export const inspectionReaders: Record<InspectionResource, Reader> = {
  companies: { table: schema.companies },
  goals: { table: schema.goals },
  users: { table: schema.authUsers },
  memberships: { table: schema.companyMemberships },
  permissions: { table: schema.principalPermissionGrants },
  agents: { table: schema.agents },
  agentIdentities: { table: schema.agentIdentityKeys, id: "agentId", omit: ["privateKeyMaterial"] },
  agentInstructions: { table: schema.agentInstructionRevisions, parent: "agentId" },
  agentConfigRevisions: { table: schema.agentConfigRevisions, parent: "agentId" },
  tasks: { table: schema.issues },
  comments: { table: schema.issueComments, parent: "issueId" },
  documents: { table: schema.documents },
  documentRevisions: { table: schema.documentRevisions, parent: "documentId" },
  taskDocuments: { table: schema.issueDocuments, parent: "issueId" },
  interactions: { table: schema.issueThreadInteractions, parent: "issueId" },
  approvals: { table: schema.approvals },
  approvalComments: { table: schema.approvalComments, parent: "approvalId" },
  decisions: { table: schema.decisions },
  routines: { table: schema.routines },
  routineTriggers: {
    table: schema.routineTriggers,
    parent: "routineId",
    omit: ["webhookSecretHash", "webhookSecret"],
  },
  routineRuns: { table: schema.routineRuns, parent: "routineId" },
  routineRevisions: { table: schema.routineRevisions, parent: "routineId" },
  routineDocuments: { table: schema.routineDocuments, parent: "routineId" },
  projects: { table: schema.projects },
  projectWorkspaces: { table: schema.projectWorkspaces, parent: "projectId" },
  projectMemberships: { table: schema.projectMemberships, parent: "projectId" },
  skills: { table: schema.companySkills, omit: ["publicShareToken"] },
  skillVersions: { table: schema.companySkillVersions, parent: "companySkillId" },
  skillSources: { table: schema.companySkillSources, omit: ["leaseToken"] },
  runs: { table: schema.heartbeatRuns, omit: ["logRef"] },
  runEvents: { table: schema.heartbeatRunEvents, parent: "runId" },
  traceMetadata: { table: schema.providerTraceRecords, parent: "runId", omit: ["traceRef"] },
  activity: { table: schema.activityLog },
  costs: { table: schema.costEvents },
  workProducts: { table: schema.issueWorkProducts, parent: "issueId" },
  artifacts: { table: schema.assets, omit: ["objectKey"] },
  attachments: { table: schema.issueAttachments, parent: "issueId" },
  connections: {
    table: schema.toolConnections,
    omit: ["externalCredential", "credentialRefs", "credentialSecretRefs"],
  },
  connectionInstalls: { table: schema.toolConnectionInstalls, parent: "connectionId" },
  connectionGrants: {
    table: schema.connectionGrants,
    parent: "connectionId",
    omit: ["credentialSecretRefs", "externalCredential"],
  },
  connectionGrantMembers: { table: schema.connectionGrantMembers, parent: "grantId" },
  connectionCatalog: { table: schema.toolCatalogEntries, parent: "connectionId" },
  toolProfiles: { table: schema.toolProfiles },
  toolProfileEntries: { table: schema.toolProfileEntries, parent: "profileId" },
  agentMemberships: { table: schema.agentMemberships, parent: "agentId" },
  agentCommentary: { table: schema.agentCommentary, parent: "runId" },
  skillPolicies: { table: schema.companySkillPolicies, id: "companyId" },
  projectGoals: { table: schema.projectGoals, parent: "projectId" },
  labels: { table: schema.labels },
  taskLabels: { table: schema.issueLabels, parent: "issueId" },
  taskRelations: { table: schema.issueRelations },
  taskApprovals: { table: schema.issueApprovals, parent: "issueId" },
  documentMemberships: { table: schema.documentMemberships, parent: "documentId" },
  documentThreads: { table: schema.documentAnnotationThreads, parent: "documentId" },
  documentComments: { table: schema.documentAnnotationComments, parent: "threadId" },
  threads: { table: schema.chatConversations, parent: "endpointId" },
};

async function ownRow(tx: Db, table: AnyPgTable, companyId: string, id: string) {
  const columns = getTableColumns(table) as Record<string, AnyPgColumn>;
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(columns.companyId, companyId), eq(columns.id, id)))
    .limit(1);
  if (!row) throw notFound("Inspection resource not found");
  return row as Record<string, unknown>;
}
function unavailable(reason: string) {
  return { available: false, reason };
}
function binary(
  bytes: Buffer,
  totalBytes: number,
  start = 0,
  contentType = "application/octet-stream",
) {
  return {
    available: true,
    encoding: "base64",
    contentType,
    totalBytes,
    start,
    end: start + bytes.length - 1,
    bytes: bytes.length,
    content: bytes.toString("base64"),
  };
}

/** All SQL, including nested serializers, runs in one read-only transaction. */
export async function readCustomerSuccessResource(
  db: Db,
  storage: StorageService,
  q: InspectionQuery,
): Promise<unknown> {
  return db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as Db;
      if (q.companyId) {
        const [company] = await tx
          .select({ id: schema.companies.id })
          .from(schema.companies)
          .where(eq(schema.companies.id, q.companyId));
        if (!company) throw notFound("Inspection company not found");
      }
      if (q.operation === "list" || q.operation === "get") {
        const reader = inspectionReaders[q.resource!];
        const all = getTableColumns(reader.table) as Record<string, AnyPgColumn>;
        const columns = Object.fromEntries(
          Object.entries(all).filter(([key]) => !reader.omit?.includes(key)),
        );
        const predicates: SQL[] = [];
        if (q.resource === "companies") {
          if (q.companyId) predicates.push(eq(all.id, q.companyId));
        } else if (q.resource === "users") {
          // Directory only, never the authentication account/session tables.
          const memberships = await tx
            .select({ userId: schema.companyMemberships.principalId })
            .from(schema.companyMemberships)
            .where(
              and(
                eq(schema.companyMemberships.companyId, q.companyId!),
                eq(schema.companyMemberships.principalType, "user"),
              ),
            );
          const { inArray } = await import("drizzle-orm");
          if (!memberships.length) {
            if (q.operation === "get") throw notFound("Inspection resource not found");
            return { items: [], nextOffset: null };
          }
          predicates.push(
            inArray(
              all.id,
              memberships.map((m) => m.userId),
            ),
          );
        } else {
          if (!all.companyId) throw unprocessable("Reader has no company boundary");
          predicates.push(eq(all.companyId, q.companyId!));
        }
        if (q.operation === "get" && !all[reader.id ?? "id"])
          throw unprocessable("This resource supports listing only");
        if (q.operation === "get") predicates.push(eq(all[reader.id ?? "id"], q.resourceId!));
        if (q.parentId) {
          if (!reader.parent || !all[reader.parent])
            throw unprocessable("This reader does not accept parentId");
          predicates.push(eq(all[reader.parent], q.parentId));
        }
        const limit = q.operation === "get" ? 1 : Math.max(1, q.limit ?? 25);
        const order = all[reader.id ?? "id"] ?? all.createdAt ?? all.companyId;
        let rows = await tx
          .select(columns)
          .from(reader.table)
          .where(and(...predicates))
          .orderBy(order)
          .limit(limit + (q.operation === "get" ? 0 : 1))
          .offset(q.offset ?? 0);
        if (q.resource === "agents")
          rows = rows.map((r) => ({
            ...r,
            adapterConfig: redactAgentAdapterConfig(r.adapterConfig as Record<string, unknown>),
            runtimeConfig: redactEventPayload(r.runtimeConfig as Record<string, unknown>),
          }));
        if (q.resource === "agentConfigRevisions")
          rows = rows.map((r) => ({
            ...r,
            beforeConfig: redactRevisionSnapshot(r.beforeConfig),
            afterConfig: redactRevisionSnapshot(r.afterConfig),
          }));
        if (q.resource === "projects" || q.resource === "routines")
          rows = rows.map((r) => ({ ...r, env: redactAgentAdapterConfig({ env: r.env }).env }));
        if (q.resource === "routineRevisions")
          rows = rows.map((r) => {
            const snapshot = r.snapshot as Record<string, unknown> | null;
            const routine = snapshot?.routine as Record<string, unknown> | undefined;
            return routine
              ? {
                  ...r,
                  snapshot: {
                    ...snapshot,
                    routine: {
                      ...routine,
                      env: redactAgentAdapterConfig({ env: routine.env }).env,
                    },
                  },
                }
              : r;
          });
        if (q.resource === "runs")
          rows = await createRunSecretRedactionRegistry(tx).redactForRuns(
            q.companyId!,
            rows as Array<{ id: string }>,
          );
        // Match the existing structured event/config redaction, without scanning
        // prose, documents, instructions, skill contents, or workspace files.
        if (
          [
            "runEvents",
            "activity",
            "connections",
            "connectionGrants",
            "routineTriggers",
            "routineRevisions",
          ].includes(q.resource!)
        )
          rows = rows.map((r) => redactEventPayload(r) ?? {});
        if (q.resource === "runEvents") {
          const redactions = createRunSecretRedactionRegistry(tx);
          rows = await Promise.all(
            rows.map((r) => redactions.redactForRun(q.companyId!, String(r.runId), r)),
          );
        }
        if (q.operation === "get") {
          if (!rows.length) throw notFound("Inspection resource not found");
          return rows[0];
        }
        return {
          items: rows.slice(0, limit),
          nextOffset: rows.length > limit ? (q.offset ?? 0) + limit : null,
        };
      }
      if (q.operation === "instructions.file") {
        const agent = await ownRow(tx, schema.agents, q.companyId!, q.resourceId!);
        const state = deriveBundleState(
          agent as unknown as Parameters<typeof deriveBundleState>[0],
        );
        if (!state.rootPath) return unavailable("instructions_not_configured");
        const relative = q.path ?? state.entryFile;
        assertWorkspaceFilePathAllowed(relative);
        const bytes = await readInstructionBytes(state.rootPath, relative);
        return bytes
          ? binary(bytes, bytes.length, 0, "text/plain; charset=utf-8")
          : unavailable("instructions_file_missing");
      }
      if (q.operation === "skills.file") {
        const skill = await ownRow(tx, schema.companySkills, q.companyId!, q.resourceId!);
        const relative = q.path ?? "SKILL.md";
        assertWorkspaceFilePathAllowed(relative);
        const versionId = q.versionId ?? skill.currentVersionId;
        // Installed version snapshots are authoritative. Reading must not invoke
        // inventory reconciliation, checkout, fetching, adoption or materialization.
        if (versionId) {
          const version = await ownRow(
            tx,
            schema.companySkillVersions,
            q.companyId!,
            String(versionId),
          );
          if (version.companySkillId !== skill.id) throw notFound("Skill version not found");
          const files = version.fileInventory as Array<{
            path: string;
            content?: string;
            encoding?: string;
          }>;
          const file = files.find((f) => f.path === relative);
          if (file?.content !== undefined) {
            const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
            if (bytes.length > MAX_INSPECTION_BYTES)
              throw unprocessable("Skill snapshot exceeds inspection limit");
            return binary(bytes, bytes.length);
          }
        }
        if (relative === "SKILL.md")
          return binary(
            Buffer.from(String(skill.markdown), "utf8"),
            Buffer.byteLength(String(skill.markdown)),
          );
        return unavailable("skill_file_not_snapshotted");
      }
      if (q.operation === "runs.log") {
        const run = await ownRow(tx, schema.heartbeatRuns, q.companyId!, q.resourceId!);
        if (!run.logRef || run.logStore !== "local_file") return unavailable("run_log_unavailable");
        const result = await getRunLogStore().read(
          { store: "local_file", logRef: String(run.logRef) },
          {
            offset: q.range?.start ?? q.offset ?? 0,
            limitBytes: q.range ? q.range.end - q.range.start + 1 : 256000,
          },
        );
        return createRunSecretRedactionRegistry(tx).redactForRun(
          q.companyId!,
          q.resourceId!,
          result,
        );
      }
      if (q.operation.startsWith("files.")) {
        try {
          const issue = await ownRow(tx, schema.issues, q.companyId!, q.resourceId!);
          const files = workspaceFileResourceService(tx, undefined, { allowComputerAccess: false });
          const input = { path: q.path ?? "", ...q.context, limit: q.limit, offset: q.offset };
          const opts = {
            issue: issue as unknown as NonNullable<Parameters<typeof files.list>[2]>["issue"],
          };
          if (q.operation === "files.list") return await files.list(q.resourceId!, input, opts);
          if (q.operation === "files.read")
            return await files.readContent(q.resourceId!, input, opts);
          const resolved = await files.prepareDownload(q.resourceId!, input, opts);
          if ("bytes" in resolved) {
            const bytes = resolved.bytes;
            if (bytes.length === 0 && !q.range) return binary(bytes, 0);
            const start = q.range?.start ?? 0;
            const end = q.range?.end ?? bytes.length - 1;
            if (start >= bytes.length || end >= bytes.length || end - start + 1 > MAX_INSPECTION_BYTES)
              throw unprocessable("Request a bounded byte range");
            // The remote backend already captured a bounded, confined snapshot;
            // do not reinterpret its path on the controller filesystem.
            return binary(bytes.subarray(start, end + 1), bytes.length, start);
          }
          const file = await fs.open(resolved.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (!stat.isFile()) throw unprocessable("Regular file required");
            if (stat.size === 0 && !q.range) return binary(Buffer.alloc(0), 0);
            const start = q.range?.start ?? 0;
            const end = q.range?.end ?? stat.size - 1;
            if (start >= stat.size || end >= stat.size || end - start + 1 > MAX_INSPECTION_BYTES)
              throw unprocessable("Request a bounded byte range");
            const bytes = Buffer.alloc(end - start + 1);
            const result = await file.read(bytes, 0, bytes.length, start);
            const after = await file.stat();
            if (
              after.size !== stat.size ||
              after.mtimeMs !== stat.mtimeMs ||
              after.ino !== stat.ino
            )
              return unavailable("file_changed_during_read");
            if (result.bytesRead !== bytes.length) return unavailable("file_changed_during_read");
            return binary(bytes, stat.size, start);
          } finally {
            await file.close();
          }
        } catch (error) {
          const code =
            error instanceof HttpError
              ? (error.details as { code?: string } | undefined)?.code
              : undefined;
          if (code && ["remote_workspace", "no_workspace", "no_local_workspace"].includes(code))
            return unavailable(code);
          throw error;
        }
      }
      if (q.operation === "assets.content") {
        const asset = await ownRow(tx, schema.assets, q.companyId!, q.resourceId!);
        const range = q.range;
        if (range && (range.start >= Number(asset.byteSize) || range.end >= Number(asset.byteSize)))
          throw unprocessable("Asset byte range is outside the resource");
        if (!range && Number(asset.byteSize) > MAX_INSPECTION_BYTES)
          throw unprocessable("Request a bounded byte range");
        const object = await storage.getObject(q.companyId!, String(asset.objectKey), { range });
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for await (const chunk of object.stream) {
            const bytes = Buffer.from(chunk);
            length += bytes.length;
            if (length > MAX_INSPECTION_BYTES)
              throw unprocessable("Asset exceeds inspection limit");
            chunks.push(bytes);
          }
        } finally {
          object.stream.destroy();
        }
        return binary(
          Buffer.concat(chunks),
          Number(asset.byteSize),
          q.range?.start ?? 0,
          object.contentType,
        );
      }
      throw unprocessable("Unsupported inspection operation");
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const record = snapshot as Record<string, unknown>;
  const object = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...record,
    adapterConfig: redactAgentAdapterConfig(object(record.adapterConfig)),
    runtimeConfig: redactEventPayload(object(record.runtimeConfig)),
    metadata:
      record.metadata && typeof record.metadata === "object"
        ? redactEventPayload(object(record.metadata))
        : (record.metadata ?? null),
  };
}
