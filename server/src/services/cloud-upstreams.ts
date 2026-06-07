import crypto, { sign } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type {
  CloudUpstreamConnectStartResponse,
  CloudUpstreamActivationDecision,
  CloudUpstreamActivationEntityType,
  CloudUpstreamConnection,
  CloudUpstreamConflict,
  CloudUpstreamPreview,
  CloudUpstreamRun,
  CloudUpstreamRunEvent,
  CloudUpstreamsState,
  CloudUpstreamSummaryCount,
  CloudUpstreamTarget,
  CloudUpstreamWarning,
  CompanyPortabilityExportResult,
  CompanyPortabilityFileEntry,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  agents,
  cloudUpstreamConnections,
  cloudUpstreamRuns,
  companies,
  goals,
  issueComments,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { companyPortabilityService } from "./company-portability.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

const DEFAULT_SCOPES = ["upstream_import:preview", "upstream_import:write", "upstream_import:read"];
const TRANSFER_SCHEMA = {
  family: "paperclip-upstream-transfer",
  version: "1.0.0",
  major: 1,
  minor: 0,
} as const;
const DEFAULT_MAX_ENTITIES_PER_CHUNK = 100;
const DISCOVERY_FETCH_TIMEOUT_MS = 30_000;
const REMOTE_FETCH_TIMEOUT_MS = 120_000;
const CLOUD_CREDENTIAL_PREFIX = "paperclip-cloud-credential:";

type NormalizedSha256 = `sha256:${string}`;

type SourceEntityKey = {
  sourceInstanceId: string;
  sourceCompanyId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceNaturalKey?: string;
};

type UpstreamTransferWarning = {
  code: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  entity?: SourceEntityKey;
};

type UpstreamTransferEntityRecord = {
  key: SourceEntityKey;
  contentHash: NormalizedSha256;
  dependencies: SourceEntityKey[];
  warnings: UpstreamTransferWarning[];
};

type LocalUpstreamExportEntity = {
  record: UpstreamTransferEntityRecord;
  body: Record<string, unknown>;
  conflictKeys?: string[];
};

type LocalUpstreamExportChunk = {
  chunkIndex: number;
  totalChunks: number;
  byteLength: number;
  sha256: NormalizedSha256;
  payload: {
    entityKeys: SourceEntityKey[];
  };
};

type UpstreamTransferManifest = {
  schema: typeof TRANSFER_SCHEMA;
  source: {
    sourceInstanceId: string;
    sourceCompanyId: string;
    sourceInstanceKeyFingerprint: string;
    exporterVersion: string;
    sourceSchemaVersion: string;
  };
  target: {
    targetStackId: string;
    targetCompanyId: string;
    targetOrigin: string;
    supportedSchemaMajor: number;
  };
  runId: string;
  idempotencyKey: string;
  generatedAt: string;
  entityCount: number;
  perEntityTypeCounts: Record<string, number>;
  entities: UpstreamTransferEntityRecord[];
  chunks: Array<Omit<LocalUpstreamExportChunk, "payload"> & { manifestHash: NormalizedSha256 }>;
  warnings: UpstreamTransferWarning[];
  featureFlags: string[];
  manifestHash: NormalizedSha256;
};

type LocalUpstreamExportBundle = {
  manifest: UpstreamTransferManifest;
  entities: LocalUpstreamExportEntity[];
  chunks: LocalUpstreamExportChunk[];
};

type ConnectionRow = typeof cloudUpstreamConnections.$inferSelect;
type RunRow = typeof cloudUpstreamRuns.$inferSelect;

export function cloudUpstreamService(db: Db, options: { instanceId?: string } = {}) {
  const sourceInstanceId = `paperclip-local-${options.instanceId ?? "default"}`;
  const portability = companyPortabilityService(db);

  return {
    list: async (companyId: string): Promise<CloudUpstreamsState> => {
      const [connectionRows, runRows] = await Promise.all([
        db
          .select()
          .from(cloudUpstreamConnections)
          .where(eq(cloudUpstreamConnections.companyId, companyId))
          .orderBy(desc(cloudUpstreamConnections.updatedAt)),
        db
          .select()
          .from(cloudUpstreamRuns)
          .where(eq(cloudUpstreamRuns.companyId, companyId))
          .orderBy(desc(cloudUpstreamRuns.createdAt))
          .limit(50),
      ]);
      return {
        connections: connectionRows.map(connectionFromRow),
        runs: runRows.map(runFromRow),
      };
    },

    startConnect: async (input: {
      companyId: string;
      remoteUrl: string;
      redirectUri: string;
    }): Promise<CloudUpstreamConnectStartResponse> => {
      await requireCompany(input.companyId);
      const remoteUrl = input.remoteUrl.trim();
      if (!remoteUrl) throw badRequest("Remote URL is required");

      const discovery = await fetchDiscovery(remoteUrl);
      const target = targetFromDiscovery(discovery);
      const connectionId = crypto.randomUUID();
      const state = crypto.randomBytes(24).toString("base64url");
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const sourcePublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
      const sourceInstanceFingerprint = `sha256:${crypto
        .createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex")}`;

      const [row] = await db.insert(cloudUpstreamConnections).values({
        id: connectionId,
        companyId: input.companyId,
        remoteUrl,
        sourceInstanceId,
        sourceInstanceFingerprint,
        sourcePublicKey,
        privateKeyPem: await sealCloudUpstreamCredential(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
        tokenStatus: "pending",
        scopes: scopesFromDiscovery(discovery),
        targetStackId: target.stackId,
        targetStackSlug: target.stackSlug,
        targetStackDisplayName: target.stackDisplayName,
        targetCompanyId: target.companyId,
        targetOrigin: target.origin,
        targetPrimaryHost: target.primaryHost,
        targetProduct: target.product,
        targetSchemaMajor: target.schemaMajor,
        targetMaxChunkBytes: target.maxChunkBytes,
        pendingState: state,
        pendingCodeVerifier: await sealCloudUpstreamCredential(codeVerifier),
        pendingRedirectUri: input.redirectUri,
        pendingTokenUrl: tokenUrlFromDiscovery(discovery),
      }).returning();
      if (!row) throw badRequest("Failed to create cloud upstream connection");

      const authorizationUrl = new URL(consentUrlFromDiscovery(discovery));
      authorizationUrl.searchParams.set("stackId", target.stackId);
      authorizationUrl.searchParams.set("redirectUri", input.redirectUri);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("codeChallenge", codeChallenge);
      authorizationUrl.searchParams.set("codeChallengeMethod", "S256");
      authorizationUrl.searchParams.set("sourceInstanceId", sourceInstanceId);
      authorizationUrl.searchParams.set("sourceInstanceFingerprint", sourceInstanceFingerprint);
      authorizationUrl.searchParams.set("sourcePublicKey", sourcePublicKey);
      authorizationUrl.searchParams.set("scopes", row.scopes.join(" "));

      return {
        pendingConnectionId: row.id,
        authorizationUrl: authorizationUrl.toString(),
        connection: connectionFromRow(row),
      };
    },

    finishConnect: async (input: {
      pendingConnectionId: string;
      code: string;
      state: string;
    }): Promise<CloudUpstreamConnection> => {
      const pending = await getConnectionRow(input.pendingConnectionId);
      if (!pending.pendingState || !pending.pendingCodeVerifier || !pending.pendingRedirectUri || !pending.pendingTokenUrl) {
        throw notFound("Pending cloud upstream connection was not found");
      }
      if (input.state !== pending.pendingState) throw badRequest("Cloud upstream state did not match");
      const tokenResponse = await postJson<Record<string, unknown>>(pending.pendingTokenUrl, {
        grantType: "authorization_code",
        code: input.code,
        redirectUri: pending.pendingRedirectUri,
        codeVerifier: await unsealCloudUpstreamCredential(pending.pendingCodeVerifier),
      });
      const accessToken = stringField(tokenResponse, "accessToken");
      const token = objectField(tokenResponse, "token");
      const expiresAt = optionalString(token.expiresAt) ?? optionalString(tokenResponse.expiresAt);
      const [updated] = await db
        .update(cloudUpstreamConnections)
        .set({
          tokenStatus: "connected",
          authorizedGlobalUserId: optionalString(token.globalUserId),
          accessToken: await sealCloudUpstreamCredential(accessToken),
          tokenId: optionalString(token.id),
          tokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
          pendingState: null,
          pendingCodeVerifier: null,
          pendingRedirectUri: null,
          pendingTokenUrl: null,
          updatedAt: new Date(),
        })
        .where(eq(cloudUpstreamConnections.id, pending.id))
        .returning();
      if (!updated) throw notFound("Cloud upstream connection was not found");
      return connectionFromRow(updated);
    },

    preview: async (connectionId: string, companyId: string): Promise<CloudUpstreamPreview> => {
      const connection = await getConnectionRow(connectionId, companyId);
      const basePreview = await localPreview(connection);
      if (!basePreview.schemaCompatible || connection.tokenStatus !== "connected") {
        return basePreview;
      }

      const bundle = await buildBundle(connection, "preview");
      const conflictKeysBySource: Record<string, string[]> = {};
      for (const entity of bundle.entities) {
        if (!entity.conflictKeys || entity.conflictKeys.length === 0) continue;
        conflictKeysBySource[sourceEntityKeyString(entity.record.key)] = [...entity.conflictKeys];
      }
      const remotePreview = await remotePost(connection, `/api/companies/${encodeURIComponent(connection.targetCompanyId)}/upstream-imports/preview`, {
        manifest: bundle.manifest,
        previewShape: "manifest_only",
        conflictKeysBySource,
      });
      return {
        ...basePreview,
        warnings: mergeWarnings(basePreview.warnings, warningsFromRemote(remotePreview)),
        conflicts: conflictsFromRemote(remotePreview),
      };
    },

    createRun: async (input: { connectionId: string; companyId: string; retryOfRunId?: string | null }): Promise<CloudUpstreamRun> => {
      const connection = await getConnectionRow(input.connectionId, input.companyId);
      if (connection.tokenStatus !== "connected") {
        throw badRequest("Cloud upstream connection is not connected");
      }
      await assertNoRunningRun(input.connectionId, input.companyId, db);
      const preview = await localPreview(connection);
      if (!preview.schemaCompatible) {
        throw badRequest("Cloud stack schema is not compatible with this local AGNB version");
      }

      const bundle = await buildBundle(connection, "apply");
      const runId = crypto.randomUUID();
      const now = new Date();
      const initialEvents = [
        event(now.toISOString(), "connect", "completed", "Connected to the target AGNB Cloud stack."),
        event(now.toISOString(), "scan", "completed", "Scanned the local company inventory."),
        event(now.toISOString(), "preview", "completed", "Generated the transfer manifest."),
        ...(input.retryOfRunId
          ? [event(now.toISOString(), "push", "retrying", `Retrying run ${input.retryOfRunId} with the same import ledger idempotency key.`)]
          : []),
      ];
      const created = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${cloudUpstreamConnections.id} from ${cloudUpstreamConnections} where ${cloudUpstreamConnections.id} = ${connection.id} and ${cloudUpstreamConnections.companyId} = ${connection.companyId} for update`,
        );
        await assertNoRunningRun(input.connectionId, input.companyId, tx);
        const [row] = await tx.insert(cloudUpstreamRuns).values({
          id: runId,
          connectionId: connection.id,
          companyId: connection.companyId,
          status: "running",
          activeStep: "push",
          progressPercent: 45,
          dryRun: false,
          retryOfRunId: input.retryOfRunId ?? null,
          summary: preview.summary,
          warnings: preview.warnings,
          conflicts: preview.conflicts,
          events: initialEvents,
          report: {},
          idempotencyKey: bundle.manifest.idempotencyKey,
          manifestHash: bundle.manifest.manifestHash,
          targetUrl: connection.targetOrigin,
          createdAt: now,
          updatedAt: now,
        }).returning();
        return row;
      });
      if (!created) throw badRequest("Failed to create cloud upstream run");

      try {
        const remoteRun = await remotePost(connection, `/api/companies/${encodeURIComponent(connection.targetCompanyId)}/upstream-imports/runs`, {
          mode: "apply",
          manifest: bundle.manifest,
          entities: bundle.entities,
        });
        const remoteRunId = remoteRunIdFromResponse(remoteRun);
        const pushedRun = await updateRunIfRunning(runId, {
          remoteRunId,
          activeStep: "push",
          progressPercent: 60,
          events: [
            ...initialEvents,
            event(new Date().toISOString(), "push", "updated", "Created or resumed the cloud import ledger run."),
          ],
        });
        if (pushedRun.status !== "running") return pushedRun;

        for (const chunk of bundle.chunks) {
          await remotePost(connection, `/api/upstream-import-runs/${encodeURIComponent(remoteRunId)}/chunks`, chunk);
        }
        const verifiedRun = await updateRunIfRunning(runId, {
          activeStep: "verify",
          progressPercent: 82,
          events: [
            ...initialEvents,
            event(new Date().toISOString(), "push", "completed", `Uploaded ${bundle.chunks.length} manifest chunk${bundle.chunks.length === 1 ? "" : "s"}.`),
          ],
        });
        if (verifiedRun.status !== "running") return verifiedRun;

        const applied = await remotePost(connection, `/api/upstream-import-runs/${encodeURIComponent(remoteRunId)}/apply`, {});
        const remoteEvents = await remoteGet(connection, `/api/upstream-import-runs/${encodeURIComponent(remoteRunId)}/events`).catch(() => null);
        const completedAt = new Date();
        const finalEvents = [
          ...initialEvents,
          event(completedAt.toISOString(), "push", "completed", "Pushed mapped objects without duplicate creation."),
          event(completedAt.toISOString(), "verify", "completed", "Verified the cloud import ledger and generated a run report."),
          event(completedAt.toISOString(), "activate", "completed", "Activation checklist is ready for manual unpause decisions."),
          ...eventsFromRemote(remoteEvents),
        ];
        const finalRun = await updateRunIfRunning(runId, {
          remoteRunId,
          status: "succeeded",
          activeStep: "activate",
          progressPercent: 100,
          warnings: mergeWarnings(preview.warnings, warningsFromRemote(applied)),
          conflicts: conflictsFromRemote(applied),
          events: finalEvents,
          report: {
            runId,
            remoteRunId,
            target: targetFromConnectionRow(connection),
            manifestHash: bundle.manifest.manifestHash,
            idempotencyKey: bundle.manifest.idempotencyKey,
            retryOfRunId: input.retryOfRunId ?? null,
            result: applied,
            events: remoteEvents,
          },
          completedAt,
        });
        if (finalRun.status === "succeeded") {
          await db
            .update(cloudUpstreamConnections)
            .set({ lastRunId: finalRun.id, updatedAt: new Date() })
            .where(eq(cloudUpstreamConnections.id, connection.id));
        }
        return finalRun;
      } catch (error) {
        const failedAt = new Date();
        const failure = cloudUpstreamRemoteFailureReport(error);
        return updateRunIfRunning(runId, {
          status: "failed",
          activeStep: "push",
          progressPercent: 100,
          events: [
            ...initialEvents,
            event(failedAt.toISOString(), "push", "failed", failure.errorMessage ?? failure.error),
          ],
          report: {
            runId,
            target: targetFromConnectionRow(connection),
            manifestHash: bundle.manifest.manifestHash,
            idempotencyKey: bundle.manifest.idempotencyKey,
            retryOfRunId: input.retryOfRunId ?? null,
            ...failure,
          },
          completedAt: failedAt,
        });
      }
    },

    readRun: async (connectionId: string, runId: string, companyId: string): Promise<CloudUpstreamRun> => {
      const row = await getRunRow(connectionId, runId, companyId);
      return runFromRow(row);
    },

    cancelRun: async (connectionId: string, runId: string, companyId: string): Promise<CloudUpstreamRun> => {
      const row = await getRunRow(connectionId, runId, companyId);
      if (row.status !== "running") return runFromRow(row);
      const connection = await getConnectionRow(connectionId, companyId);
      if (row.remoteRunId) {
        await remotePost(connection, `/api/upstream-import-runs/${encodeURIComponent(row.remoteRunId)}/cancel`, {}).catch(() => null);
      }
      return updateRun(row.id, {
        status: "cancelled",
        activeStep: "push",
        progressPercent: 100,
        completedAt: new Date(),
        events: [
          ...row.events,
          event(new Date().toISOString(), "push", "failed", "Push cancelled locally before remote apply completed."),
        ],
      });
    },

    activateRunEntities: async (input: {
      connectionId: string;
      runId: string;
      companyId: string;
      entityType: CloudUpstreamActivationEntityType;
    }): Promise<CloudUpstreamRun> => {
      const row = await getRunRow(input.connectionId, input.runId, input.companyId);
      assertActivationEntityType(input.entityType);
      if (row.status !== "succeeded") {
        throw badRequest("Only succeeded cloud upstream runs can activate imported entities");
      }

      const activatedAt = new Date().toISOString();
      const count = summaryCount(row.summary, input.entityType);
      const nextDecision: CloudUpstreamActivationDecision = {
        entityType: input.entityType,
        count,
        status: "activated",
        activatedAt,
      };
      const report = asRecord(row.report);
      const activationChecklist = activationChecklistFromReport(report);
      const label = activationEntityLabel(input.entityType, count);

      return updateRun(row.id, {
        report: {
          ...report,
          activationChecklist: {
            ...activationChecklist,
            [input.entityType]: nextDecision,
          },
        },
        events: [
          ...row.events,
          event(activatedAt, "activate", "completed", `Activated ${count} imported ${label}.`),
        ],
      });
    },
  };

  async function requireCompany(companyId: string) {
    const row = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0]);
    if (!row) throw notFound("Company was not found");
  }

  async function getConnectionRow(connectionId: string, companyId?: string): Promise<ConnectionRow> {
    const row = await db
      .select()
      .from(cloudUpstreamConnections)
      .where(companyId
        ? and(eq(cloudUpstreamConnections.id, connectionId), eq(cloudUpstreamConnections.companyId, companyId))
        : eq(cloudUpstreamConnections.id, connectionId))
      .then((rows) => rows[0]);
    if (!row) throw notFound("Cloud upstream connection was not found");
    return row;
  }

  async function getRunRow(connectionId: string, runId: string, companyId: string): Promise<RunRow> {
    const row = await db
      .select()
      .from(cloudUpstreamRuns)
      .where(and(
        eq(cloudUpstreamRuns.id, runId),
        eq(cloudUpstreamRuns.connectionId, connectionId),
        eq(cloudUpstreamRuns.companyId, companyId),
      ))
      .then((rows) => rows[0]);
    if (!row) throw notFound("Cloud upstream run was not found");
    return row;
  }

  async function assertNoRunningRun(
    connectionId: string,
    companyId: string,
    database: Pick<Db, "select">,
  ) {
    const [running] = await database
      .select({ id: cloudUpstreamRuns.id })
      .from(cloudUpstreamRuns)
      .where(and(
        eq(cloudUpstreamRuns.connectionId, connectionId),
        eq(cloudUpstreamRuns.companyId, companyId),
        eq(cloudUpstreamRuns.status, "running"),
      ))
      .limit(1);
    if (running) {
      throw conflict("A cloud upstream run is already running for this connection", { runId: running.id });
    }
  }

  async function updateRun(runId: string, patch: Partial<typeof cloudUpstreamRuns.$inferInsert>): Promise<CloudUpstreamRun> {
    const [updated] = await db
      .update(cloudUpstreamRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(cloudUpstreamRuns.id, runId))
      .returning();
    if (!updated) throw notFound("Cloud upstream run was not found");
    return runFromRow(updated);
  }

  async function updateRunIfRunning(runId: string, patch: Partial<typeof cloudUpstreamRuns.$inferInsert>): Promise<CloudUpstreamRun> {
    const [updated] = await db
      .update(cloudUpstreamRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(cloudUpstreamRuns.id, runId), eq(cloudUpstreamRuns.status, "running")))
      .returning();
    if (updated) return runFromRow(updated);

    const [current] = await db
      .select()
      .from(cloudUpstreamRuns)
      .where(eq(cloudUpstreamRuns.id, runId))
      .limit(1);
    if (!current) throw notFound("Cloud upstream run was not found");
    return runFromRow(current);
  }

  async function localPreview(connection: ConnectionRow): Promise<CloudUpstreamPreview> {
    return {
      connectionId: connection.id,
      sourceCompanyId: connection.companyId,
      target: targetFromConnectionRow(connection),
      schemaCompatible: connection.targetSchemaMajor === TRANSFER_SCHEMA.major,
      summary: await buildSummary(connection.companyId),
      warnings: buildWarnings(connection.targetSchemaMajor),
      conflicts: [],
      generatedAt: new Date().toISOString(),
    };
  }

  async function buildSummary(companyId: string): Promise<CloudUpstreamSummaryCount[]> {
    const [agentCount, projectCount, goalCount, issueCount, commentCount, routineCount] = await Promise.all([
      db.select({ count: count() }).from(agents).where(eq(agents.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: count() }).from(projects).where(eq(projects.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: count() }).from(goals).where(eq(goals.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: count() }).from(issues).where(eq(issues.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: count() }).from(issueComments).where(eq(issueComments.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: count() }).from(routines).where(eq(routines.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
    ]);
    return [
      { key: "companies", label: "Companies", count: 1 },
      { key: "goals", label: "Goals", count: goalCount },
      { key: "projects", label: "Projects", count: projectCount },
      { key: "agents", label: "Agents", count: agentCount },
      { key: "issues", label: "Issues", count: issueCount },
      { key: "comments", label: "Comments", count: commentCount },
      { key: "routines", label: "Routines", count: routineCount },
      { key: "warnings", label: "Warnings", count: buildWarnings(TRANSFER_SCHEMA.major).length },
    ];
  }

  async function buildBundle(connection: ConnectionRow, mode: "preview" | "apply"): Promise<LocalUpstreamExportBundle> {
    const exported = await portability.exportBundle(connection.companyId, {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      expandReferencedSkills: true,
    });
    const sourceHash = normalizedContentHash({
      manifest: exported.manifest,
      files: exported.files,
    });
    const source = {
      sourceInstanceId: connection.sourceInstanceId,
      sourceCompanyId: connection.companyId,
      sourceInstanceKeyFingerprint: connection.sourceInstanceFingerprint,
      exporterVersion: "paperclip-local-cloud-ui-v1",
      sourceSchemaVersion: TRANSFER_SCHEMA.version,
    };
    const target = {
      targetStackId: connection.targetStackId,
      targetCompanyId: connection.targetCompanyId,
      targetOrigin: connection.targetOrigin,
      supportedSchemaMajor: connection.targetSchemaMajor,
    };
    const idempotencyKey = [
      mode,
      connection.sourceInstanceId,
      connection.companyId,
      connection.targetStackId,
      sourceHash,
    ].join(":");
    return buildLocalUpstreamExportBundle({
      source,
      target,
      runId: `local-${mode}-${shortHash(idempotencyKey)}`,
      idempotencyKey,
      entities: buildEntitiesFromPortableExport(connection.companyId, connection.sourceInstanceId, exported),
      warnings: exported.warnings.map((message): UpstreamTransferWarning => ({
        code: "local_company_export_warning",
        severity: "warning",
        message,
      })),
      featureFlags: ["cloud_sync"],
      maxEntitiesPerChunk: DEFAULT_MAX_ENTITIES_PER_CHUNK,
    });
  }
}

async function fetchDiscovery(remoteUrl: string): Promise<Record<string, unknown>> {
  const parsed = new URL(remoteUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw badRequest("Cloud upstream targets require HTTPS except localhost development");
  }
  const stackId = firstPathSegment(parsed.pathname);
  const discoveryUrl = new URL("/.well-known/paperclip-upstream", parsed.origin);
  if (stackId) {
    discoveryUrl.searchParams.set("stackId", stackId);
  }
  const response = await fetchWithTimeout(discoveryUrl, undefined, DISCOVERY_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw badRequest(`Cloud upstream discovery failed: ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

export async function reconcileCloudUpstreamRunsOnStartup(db: Db, now = new Date()): Promise<{ reconciled: number }> {
  const runningRows = await db
    .select()
    .from(cloudUpstreamRuns)
    .where(eq(cloudUpstreamRuns.status, "running"));
  if (runningRows.length === 0) return { reconciled: 0 };

  for (const row of runningRows) {
    const report = asRecord(row.report);
    await db
      .update(cloudUpstreamRuns)
      .set({
        status: "failed",
        activeStep: row.activeStep,
        progressPercent: 100,
        completedAt: now,
        updatedAt: now,
        events: [
          ...safeRunEvents(row.events),
          event(
            now.toISOString(),
            cloudUpstreamStep(row.activeStep),
            "failed",
            "Marked failed on server startup because the previous process stopped while the cloud upstream run was in progress.",
          ),
        ],
        report: {
          ...report,
          error: optionalString(report.error) ?? "orphaned_running_run",
          errorMessage: optionalString(report.errorMessage)
            ?? "The server restarted while this cloud upstream run was running, so AGNB marked it failed instead of leaving it stuck.",
          reconciledAt: now.toISOString(),
        },
      })
      .where(eq(cloudUpstreamRuns.id, row.id));
  }

  return { reconciled: runningRows.length };
}

function firstPathSegment(pathname: string): string | null {
  const segment = pathname.split("/").find(Boolean);
  return segment && segment.toLowerCase() !== "dashboard" ? segment : null;
}

function targetFromDiscovery(discovery: Record<string, unknown>): CloudUpstreamTarget {
  const stack = objectField(discovery, "stack");
  const transfer = objectField(discovery, "transfer");
  const schema = optionalObject(transfer.schema);
  const origin = stringField(stack, "origin");
  return {
    stackId: stringField(stack, "id"),
    stackSlug: optionalString(stack.slug),
    stackDisplayName: optionalString(stack.displayName),
    companyId: stringField(stack, "companyId"),
    primaryHost: optionalString(stack.primaryHost) ?? new URL(origin).host,
    origin,
    product: optionalString(discovery.product) ?? "AGNB Cloud",
    schemaMajor: optionalNumber(schema?.major) ?? numberField(transfer, "supportedSchemaMajor"),
    maxChunkBytes: optionalNumber(transfer.maxChunkBytes) ?? 8 * 1024 * 1024,
  };
}

function targetFromConnectionRow(row: ConnectionRow): CloudUpstreamTarget {
  return {
    stackId: row.targetStackId,
    stackSlug: row.targetStackSlug,
    stackDisplayName: row.targetStackDisplayName,
    companyId: row.targetCompanyId,
    primaryHost: row.targetPrimaryHost,
    origin: row.targetOrigin,
    product: row.targetProduct,
    schemaMajor: row.targetSchemaMajor,
    maxChunkBytes: row.targetMaxChunkBytes,
  };
}

function connectionFromRow(row: ConnectionRow): CloudUpstreamConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    remoteUrl: row.remoteUrl,
    target: targetFromConnectionRow(row),
    tokenStatus: cloudUpstreamTokenStatus(row.tokenStatus),
    scopes: row.scopes,
    authorizedGlobalUserId: row.authorizedGlobalUserId,
    expiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRunId: row.lastRunId,
  };
}

function runFromRow(row: RunRow): CloudUpstreamRun {
  return {
    id: row.id,
    connectionId: row.connectionId,
    companyId: row.companyId,
    status: cloudUpstreamRunStatus(row.status),
    activeStep: cloudUpstreamStep(row.activeStep),
    progressPercent: row.progressPercent,
    dryRun: row.dryRun,
    summary: row.summary,
    warnings: row.warnings,
    conflicts: row.conflicts,
    events: row.events,
    targetUrl: row.targetUrl,
    report: row.report,
    retryOfRunId: row.retryOfRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function scopesFromDiscovery(discovery: Record<string, unknown>): string[] {
  const auth = objectField(discovery, "auth");
  const scopes = Array.isArray(auth.scopes) ? auth.scopes.map(String).filter(Boolean) : [];
  return scopes.length > 0 ? scopes : [...DEFAULT_SCOPES];
}

function consentUrlFromDiscovery(discovery: Record<string, unknown>): string {
  const pkce = objectField(objectField(discovery, "auth"), "pkce");
  return optionalString(pkce.consentUrl) ?? stringField(pkce, "authorizeUrl");
}

function tokenUrlFromDiscovery(discovery: Record<string, unknown>): string {
  return stringField(objectField(objectField(discovery, "auth"), "pkce"), "tokenUrl");
}

function buildWarnings(schemaMajor: number): CloudUpstreamWarning[] {
  const warnings: CloudUpstreamWarning[] = [
    {
      code: "imported_automations_paused",
      severity: "warning",
      title: "Automations stay paused",
      detail: "Imported agents, routines, and monitors require explicit activation after the push.",
    },
    {
      code: "unmatched_users_import_as_historical_authors",
      severity: "warning",
      title: "Unmatched users become historical authors",
      detail: "Invite now remains a secondary action after the transfer is complete.",
    },
    {
      code: "secret_values_redacted",
      severity: "warning",
      title: "Secret values are not transferred",
      detail: "The push carries secret requirements only. Configure cloud secrets before activating automations.",
    },
  ];
  if (schemaMajor !== TRANSFER_SCHEMA.major) {
    warnings.unshift({
      code: "schema_mismatch",
      severity: "blocker",
      title: "Cloud stack upgrade required",
      detail: `This local build uses upstream schema ${TRANSFER_SCHEMA.major}, but the cloud stack reports schema ${schemaMajor}.`,
    });
  }
  return warnings;
}

type LocalUpstreamExportEntityInput = {
  key: SourceEntityKey;
  body: Record<string, unknown>;
  dependencies?: SourceEntityKey[];
  warnings?: UpstreamTransferWarning[];
  conflictKeys?: string[];
};

function buildEntitiesFromPortableExport(
  localCompanyId: string,
  sourceInstanceId: string,
  exported: CompanyPortabilityExportResult,
): LocalUpstreamExportEntityInput[] {
  const companyKey: SourceEntityKey = {
    sourceInstanceId,
    sourceCompanyId: localCompanyId,
    sourceEntityType: "company",
    sourceEntityId: localCompanyId,
    sourceNaturalKey: exported.manifest.company?.name ?? localCompanyId,
  };
  const entities: LocalUpstreamExportEntityInput[] = [
    {
      key: companyKey,
      body: {
        kind: "paperclip_company_portability_manifest",
        manifest: exported.manifest,
        rootPath: exported.rootPath,
        paperclipExtensionPath: exported.paperclipExtensionPath,
        fileCount: Object.keys(exported.files).length,
      },
      conflictKeys: [`company:${companyKey.sourceNaturalKey ?? localCompanyId}`],
    },
  ];

  for (const [filePath, entry] of Object.entries(exported.files).sort(([left], [right]) => left.localeCompare(right))) {
    entities.push({
      key: {
        sourceInstanceId,
        sourceCompanyId: localCompanyId,
        sourceEntityType: "company_setting",
        sourceEntityId: shortHash(filePath),
        sourceNaturalKey: filePath,
      },
      body: {
        kind: "paperclip_portable_file",
        path: filePath,
        entry: normalizePortableFileEntry(entry),
      },
      dependencies: [companyKey],
      conflictKeys: [`portable_file:${filePath}`],
    });
  }
  return entities;
}

function normalizePortableFileEntry(entry: CompanyPortabilityFileEntry): Record<string, unknown> {
  if (typeof entry === "string") {
    return { encoding: "utf8", data: entry };
  }
  return { ...entry };
}

function buildLocalUpstreamExportBundle(input: {
  source: UpstreamTransferManifest["source"];
  target: UpstreamTransferManifest["target"];
  runId: string;
  idempotencyKey: string;
  entities: LocalUpstreamExportEntityInput[];
  warnings?: UpstreamTransferWarning[];
  featureFlags?: string[];
  maxEntitiesPerChunk?: number;
}): LocalUpstreamExportBundle {
  const entities = input.entities.map<LocalUpstreamExportEntity>((entity) => ({
    record: {
      key: entity.key,
      contentHash: normalizedContentHash(entity.body),
      dependencies: entity.dependencies ?? [],
      warnings: entity.warnings ?? [],
    },
    body: entity.body,
    conflictKeys: entity.conflictKeys,
  }));
  const chunksWithoutManifestHash = buildLocalChunks(entities, input.maxEntitiesPerChunk ?? DEFAULT_MAX_ENTITIES_PER_CHUNK);
  const manifestWithoutHash = {
    schema: TRANSFER_SCHEMA,
    source: input.source,
    target: input.target,
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    generatedAt: new Date(0).toISOString(),
    entityCount: entities.length,
    perEntityTypeCounts: countEntityTypesForManifest(entities),
    entities: entities.map((entity) => entity.record),
    chunks: chunksWithoutManifestHash.map(({ payload: _payload, ...chunk }) => chunk),
    warnings: input.warnings ?? [],
    featureFlags: (input.featureFlags ?? ["cloud_sync"]).slice().sort(),
  };
  const manifestHash = normalizedContentHash(manifestWithoutHash);
  return {
    manifest: {
      ...manifestWithoutHash,
      chunks: chunksWithoutManifestHash.map(({ payload: _payload, ...chunk }) => ({ ...chunk, manifestHash })),
      manifestHash,
    },
    entities,
    chunks: chunksWithoutManifestHash,
  };
}

function countEntityTypesForManifest(entities: LocalUpstreamExportEntity[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of entities) {
    const entityType = entity.record.key.sourceEntityType;
    counts[entityType] = (counts[entityType] ?? 0) + 1;
  }
  return counts;
}

function buildLocalChunks(entities: LocalUpstreamExportEntity[], maxEntitiesPerChunk: number): LocalUpstreamExportChunk[] {
  if (!Number.isInteger(maxEntitiesPerChunk) || maxEntitiesPerChunk < 1) {
    throw new Error("maxEntitiesPerChunk must be a positive integer");
  }
  if (entities.length === 0) return [];

  const groups: LocalUpstreamExportEntity[][] = [];
  for (let index = 0; index < entities.length; index += maxEntitiesPerChunk) {
    groups.push(entities.slice(index, index + maxEntitiesPerChunk));
  }

  return groups.map((group, index) => {
    const payload = {
      entityKeys: group.map((entity) => entity.record.key),
    };
    return {
      chunkIndex: index,
      totalChunks: groups.length,
      byteLength: Buffer.byteLength(canonicalJson(payload)),
      sha256: normalizedContentHash(payload),
      payload,
    };
  });
}

async function remoteGet(connection: ConnectionRow, path: string): Promise<unknown> {
  const response = await fetchWithTimeout(`${connection.targetOrigin}${path}`, {
    method: "GET",
    headers: await proofHeaders(connection, "GET", path),
  }, REMOTE_FETCH_TIMEOUT_MS);
  return parseRemoteResponse(response);
}

async function remotePost(connection: ConnectionRow, path: string, body: unknown): Promise<unknown> {
  const response = await fetchWithTimeout(`${connection.targetOrigin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...await proofHeaders(connection, "POST", path),
    },
    body: JSON.stringify(body),
  }, REMOTE_FETCH_TIMEOUT_MS);
  return parseRemoteResponse(response);
}

async function proofHeaders(connection: ConnectionRow, method: string, pathAndSearch: string): Promise<Record<string, string>> {
  if (!connection.accessToken || !connection.tokenId) {
    throw badRequest("Cloud upstream connection is missing an import token");
  }
  const accessToken = await unsealCloudUpstreamCredential(connection.accessToken);
  const privateKeyPem = await unsealCloudUpstreamCredential(connection.privateKeyPem);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const payload = [
    method,
    new URL(connection.targetOrigin).host.toLowerCase(),
    pathAndSearch,
    connection.tokenId,
    connection.sourceInstanceId,
    timestamp,
    nonce,
  ].join("\n");
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Paperclip-Upstream-Source-Instance-Id": connection.sourceInstanceId,
    "X-Paperclip-Upstream-Proof-Timestamp": timestamp,
    "X-Paperclip-Upstream-Proof-Nonce": nonce,
    "X-Paperclip-Upstream-Proof-Signature": sign(
      null,
      Buffer.from(payload, "utf8"),
      privateKeyPem,
    ).toString("base64url"),
  };
}

async function parseRemoteResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeParseJson(text) : {};
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed !== null && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `Cloud upstream request failed: ${response.status}`;
    throw badRequest(message, parsed);
  }
  return parsed;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function sealCloudUpstreamCredential(value: string): Promise<string> {
  const prepared = await localEncryptedProvider.createSecret({ value });
  return `${CLOUD_CREDENTIAL_PREFIX}${JSON.stringify(prepared.material)}`;
}

export async function unsealCloudUpstreamCredential(value: string): Promise<string> {
  if (!value.startsWith(CLOUD_CREDENTIAL_PREFIX)) return value;
  const encoded = value.slice(CLOUD_CREDENTIAL_PREFIX.length);
  const parsed = safeParseJson(encoded);
  const material = optionalObject(parsed);
  if (!material) {
    throw badRequest("Invalid encrypted cloud upstream credential material");
  }
  return localEncryptedProvider.resolveVersion({
    material,
    externalRef: null,
  });
}

export function cloudUpstreamRemoteFailureReport(error: unknown): {
  error: string;
  errorMessage?: string;
  details?: unknown;
} {
  const fallback = error instanceof Error ? error.message : String(error);
  if (!(error instanceof HttpError)) {
    return { error: fallback };
  }
  const remote = remoteErrorBody(error.details);
  return {
    error: remote.error ?? error.message,
    ...(remote.message ? { errorMessage: remote.message } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}

function remoteErrorBody(details: unknown): { error?: string; message?: string } {
  const record = optionalObject(details);
  if (!record) return {};
  return {
    error: optionalString(record.error) ?? undefined,
    message: optionalString(record.message) ?? undefined,
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, DISCOVERY_FETCH_TIMEOUT_MS);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw badRequest((payload as { error?: string } | null)?.error ?? `Cloud upstream request failed: ${response.status}`);
  }
  return payload as T;
}

function remoteRunIdFromResponse(value: unknown): string {
  const record = asRecord(value);
  const run = asRecord(record.run);
  const id = optionalString(run.id);
  if (!id) throw badRequest("Remote upstream importer did not return a run id");
  return id;
}

function warningsFromRemote(value: unknown): CloudUpstreamWarning[] {
  const record = asRecord(value);
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  return warnings.map((warning, index): CloudUpstreamWarning => {
    const item = asRecord(warning);
    const code = optionalString(item.code) ?? `remote_warning_${index}`;
    const severity = item.severity === "blocker" ? "blocker" : "warning";
    const message = optionalString(item.message) ?? optionalString(item.detail) ?? "Remote importer warning.";
    return {
      code,
      severity,
      title: titleFromCode(code),
      detail: message,
    };
  });
}

function conflictsFromRemote(value: unknown): CloudUpstreamConflict[] {
  const record = asRecord(value);
  const conflicts = Array.isArray(record.conflicts) ? record.conflicts : [];
  return conflicts.map((conflict, index): CloudUpstreamConflict => {
    const item = asRecord(conflict);
    const source = asRecord(item.source);
    return {
      id: optionalString(item.id) ?? `remote-conflict-${index}`,
      entityType: optionalString(item.entityType) ?? optionalString(source.sourceEntityType) ?? "entity",
      sourceLabel: optionalString(item.sourceLabel) ?? optionalString(source.sourceNaturalKey) ?? optionalString(source.sourceEntityId) ?? "Source entity",
      targetLabel: optionalString(item.targetLabel) ?? optionalString(item.targetEntityId) ?? "Cloud entity",
      plannedAction: "blocked",
      reason: optionalString(item.reason) ?? "Remote importer reported a conflict.",
    };
  });
}

function eventsFromRemote(value: unknown): CloudUpstreamRunEvent[] {
  const record = asRecord(value);
  const events = Array.isArray(record.events) ? record.events : [];
  return events.slice(-25).map((remote, index) => {
    const item = asRecord(remote);
    const action = optionalString(item.action) ?? "updated";
    return event(
      optionalString(item.createdAt) ?? new Date().toISOString(),
      "verify",
      action.includes("created") ? "created" : "updated",
      `Cloud importer ${action.replace(/_/g, " ")}${index >= 0 ? "." : "."}`,
    );
  });
}

function safeRunEvents(value: unknown): CloudUpstreamRunEvent[] {
  return Array.isArray(value) ? value as CloudUpstreamRunEvent[] : [];
}

function assertActivationEntityType(value: string): asserts value is CloudUpstreamActivationEntityType {
  if (value !== "agents" && value !== "routines" && value !== "monitors") {
    throw badRequest("entityType must be agents, routines, or monitors");
  }
}

function summaryCount(summary: unknown, key: CloudUpstreamActivationEntityType): number {
  if (!Array.isArray(summary)) return 0;
  const item = summary.find((entry) => asRecord(entry).key === key);
  const count = asRecord(item).count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function activationChecklistFromReport(report: Record<string, unknown>): Record<string, CloudUpstreamActivationDecision> {
  const value = asRecord(report.activationChecklist);
  const decisions: Record<string, CloudUpstreamActivationDecision> = {};
  for (const [key, decision] of Object.entries(value)) {
    if (key !== "agents" && key !== "routines" && key !== "monitors") continue;
    const item = asRecord(decision);
    decisions[key] = {
      entityType: key,
      count: typeof item.count === "number" && Number.isFinite(item.count) ? item.count : 0,
      status: item.status === "activated" ? "activated" : "paused",
      activatedAt: optionalString(item.activatedAt),
    };
  }
  return decisions;
}

function activationEntityLabel(entityType: CloudUpstreamActivationEntityType, count: number): string {
  const singular = entityType === "agents" ? "agent" : entityType === "routines" ? "routine" : "monitor";
  return `${singular}${count === 1 ? "" : "s"}`;
}

function mergeWarnings(base: CloudUpstreamWarning[], extra: CloudUpstreamWarning[]): CloudUpstreamWarning[] {
  const byCode = new Map<string, CloudUpstreamWarning>();
  for (const warning of [...base, ...extra]) byCode.set(warning.code, warning);
  return [...byCode.values()];
}

function event(
  at: string,
  phase: CloudUpstreamRunEvent["phase"],
  type: CloudUpstreamRunEvent["type"],
  message: string,
): CloudUpstreamRunEvent {
  return {
    id: crypto.randomUUID(),
    at,
    phase,
    type,
    message,
  };
}

function normalizedContentHash(value: unknown): NormalizedSha256 {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sourceEntityKeyString(key: SourceEntityKey): string {
  return [key.sourceInstanceId, key.sourceCompanyId, key.sourceEntityType, key.sourceEntityId]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function titleFromCode(code: string): string {
  return code
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw badRequest(`Cloud upstream discovery missing ${key}`);
  }
  return field as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw badRequest(`Cloud upstream discovery missing ${key}`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw badRequest(`Cloud upstream discovery missing ${key}`);
  }
  return field;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cloudUpstreamTokenStatus(value: string): CloudUpstreamConnection["tokenStatus"] {
  return value === "connected" || value === "expired" || value === "revoked" ? value : "pending";
}

function cloudUpstreamRunStatus(value: string): CloudUpstreamRun["status"] {
  return value === "previewed" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : "failed";
}

function cloudUpstreamStep(value: string): CloudUpstreamRun["activeStep"] {
  return value === "connect" || value === "scan" || value === "preview" || value === "push" || value === "verify" || value === "activate"
    ? value
    : "push";
}
