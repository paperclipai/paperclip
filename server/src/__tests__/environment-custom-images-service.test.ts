import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  environmentCustomImageSetupSessions,
  environmentCustomImageTemplates,
  environments,
  plugins,
} from "@paperclipai/db";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  environmentCustomImageService,
} from "../services/environment-custom-images.js";
import {
  ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
  environmentCustomImageTemplateMatchesBaseConfig,
  fingerprintEnvironmentSandboxProviderConfig,
} from "../services/environment-custom-image-runtime.js";
import {
  resolveEnvironmentDriverConfigForRuntime,
} from "../services/environment-config.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment customImage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function pluginManifest() {
  return {
    id: "paperclip.fake-sandbox-provider",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Fake Sandbox Provider",
    categories: ["automation"],
    capabilities: ["environment.drivers.register"],
    entrypoints: { worker: "./dist/worker.js" },
    environmentDrivers: [
      {
        driverKey: "fake-plugin",
        kind: "sandbox_provider",
        displayName: "Fake Sandbox Provider",
        supportsInteractiveSetup: true,
        interactiveSetupConnectionTypes: ["ssh"],
        supportsTemplateCapture: true,
        templateRefKind: "snapshot",
        templateConfigBinding: {
          field: "customTemplate",
          unsetFields: ["image"],
        },
        templateIdentityPaths: ["apiUrl"],
        supportsTemplateDelete: true,
        configSchema: { type: "object" },
      },
    ],
  } as const;
}

function createWorkerManager() {
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
    if (method === "environmentStartInteractiveSetup") {
      return {
        providerLeaseId: `lease-${params.sessionId}`,
        status: "waiting_for_user",
        connectionSummary: {
          type: "ssh",
          username: "sandbox",
          hostRedacted: true,
          portRedacted: true,
        },
        connectionPayload: {
          type: "ssh",
          command: "ssh sandbox@203.0.113.10",
          expiresAt: params.expiresAt,
        },
        expiresAt: params.expiresAt,
        metadata: {
          connectUrl: "https://203.0.113.10/setup",
          safeLabel: "setup",
        },
      };
    }
    if (method === "environmentGetInteractiveSetup") {
      return {
        providerLeaseId: params.providerLeaseId,
        status: "waiting_for_user",
        connectionSummary: {
          type: "ssh",
          username: "sandbox",
          hostRedacted: true,
          portRedacted: true,
        },
        connectionPayload: {
          type: "ssh",
          command: "ssh sandbox@203.0.113.10",
        },
        metadata: {
          safeLabel: "setup",
        },
      };
    }
    if (method === "environmentCaptureTemplate") {
      return {
        templateRef: `snapshot-${String(params.providerLeaseId).slice(-8)}`,
        templateKind: "snapshot",
        metadata: {
          provider: "fake-plugin",
          sourceTemplateRefRedacted: Boolean(params.sourceTemplateRef),
          previousTemplateRefRedacted: Boolean(params.previousTemplateRef),
        },
      };
    }
    if (method === "environmentCancelInteractiveSetup") {
      return {
        status: params.reason === "timed_out" ? "timed_out" : "cancelled",
        metadata: { provider: "fake-plugin", found: true },
      };
    }
    if (method === "environmentDeleteTemplate") {
      return { deleted: true, metadata: { provider: "fake-plugin" } };
    }
    throw new Error(`Unexpected plugin call: ${method}`);
  });
  return {
    call,
    isRunning: vi.fn(() => true),
  } as unknown as PluginWorkerManager & { call: typeof call };
}

describeEmbeddedPostgres("environmentCustomImageService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-custom-images");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(environmentCustomImageSetupSessions);
    await db.delete(environmentCustomImageTemplates);
    await db.delete(plugins);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values(
      { id: companyId, name: "Acme", issuePrefix: `A${companyId.slice(0, 4)}` },
    );
    await db.insert(environments).values({
      id: environmentId,
      name: `Fake ${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:base",
        reuseLease: false,
      },
      envVars: {},
    });
    await db.insert(plugins).values({
      pluginKey: "paperclip.fake-sandbox-provider",
      packageName: "paperclip-plugin-fake-sandbox",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: pluginManifest(),
      status: "ready",
    });
    return { companyId, environmentId };
  }

  it("starts, refreshes, finishes, refreshes again, and rolls back setup sessions", async () => {
    const { environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
      ttlSeconds: 600,
    });

    expect(started.session.status).toBe("waiting_for_user");
    expect(started.connectionPayload?.command).toContain("203.0.113.10");
    expect(JSON.stringify(started.session.metadata)).not.toContain("203.0.113.10");

    const status = await service.refreshSetupSession({
      sessionId: started.session.id,
      includeConnectionPayload: true,
    });
    expect(status.connectionPayload?.command).toContain("ssh sandbox@203.0.113.10");

    const promoted = await service.finishSetupSession({ sessionId: started.session.id });
    expect(promoted.session.status).toBe("promoted");
    expect(promoted.template.status).toBe("active");
    expect(promoted.template.templateKind).toBe("snapshot");
    expect(promoted.template.metadata).toMatchObject({
      runtimeConfigBinding: {
        field: "customTemplate",
        unsetFields: ["image"],
      },
    });

    const refresh = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
    });
    const replacement = await service.finishSetupSession({ sessionId: refresh.session.id });
    expect(replacement.template.id).not.toBe(promoted.template.id);

    const rollback = await service.rollbackTemplate({ environmentId });
    expect(rollback.activeTemplate.id).toBe(promoted.template.id);
    expect(rollback.supersededTemplate.id).toBe(replacement.template.id);
  });

  it("reuses the setup provider company context across lifecycle calls", async () => {
    const { companyId, environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
      secretContextCompanyId: companyId,
    });
    expect(started.session.metadata).toMatchObject({
      setupRpcCompanyId: companyId,
    });

    await service.refreshSetupSession({
      sessionId: started.session.id,
      includeConnectionPayload: true,
    });
    const promoted = await service.finishSetupSession({ sessionId: started.session.id });

    const lifecycleCalls = workerManager.call.mock.calls
      .filter(([, method]) => [
        "environmentStartInteractiveSetup",
        "environmentGetInteractiveSetup",
        "environmentCaptureTemplate",
        "environmentCancelInteractiveSetup",
      ].includes(method))
      .map(([, method, params]) => ({
        method,
        companyId: (params as Record<string, unknown>).companyId,
      }));

    expect(lifecycleCalls).toEqual([
      { method: "environmentStartInteractiveSetup", companyId },
      { method: "environmentGetInteractiveSetup", companyId },
      { method: "environmentCaptureTemplate", companyId },
      { method: "environmentCancelInteractiveSetup", companyId },
    ]);
    expect(promoted.session.metadata).toMatchObject({
      setupRpcCompanyId: companyId,
    });
    expect(promoted.template.metadata).toMatchObject({
      setupRpcCompanyId: companyId,
    });
  });

  it("revokes the active template before deleting the provider template", async () => {
    const { environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
    });
    const promoted = await service.finishSetupSession({ sessionId: started.session.id });
    let statusAtProviderDelete: string | null = null;
    workerManager.call.mockImplementation(async (_pluginId, method) => {
      if (method !== "environmentDeleteTemplate") {
        throw new Error(`Unexpected plugin call after setup: ${method}`);
      }
      const [row] = await db
        .select({ status: environmentCustomImageTemplates.status })
        .from(environmentCustomImageTemplates)
        .where(eq(environmentCustomImageTemplates.id, promoted.template.id));
      statusAtProviderDelete = row?.status ?? null;
      return { deleted: true, metadata: { provider: "fake-plugin" } };
    });

    const disabled = await service.disableTemplate({
      environmentId,
      deleteProviderTemplate: true,
    });

    expect(disabled.status).toBe("revoked");
    expect(statusAtProviderDelete).toBe("revoked");
    expect(workerManager.call).toHaveBeenLastCalledWith(
      expect.any(String),
      "environmentDeleteTemplate",
      expect.objectContaining({
        templateRef: promoted.template.templateRef,
        reason: "disabled",
      }),
      undefined,
    );
  });

  it("does not send provider template refs to a different current provider", async () => {
    const { environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
    });
    const promoted = await service.finishSetupSession({ sessionId: started.session.id });
    const deleteCallsBefore = workerManager.call.mock.calls
      .filter(([, method]) => method === "environmentDeleteTemplate")
      .length;

    await db.update(environments)
      .set({
        config: {
          provider: "other-plugin",
          image: "other:base",
          reuseLease: false,
        },
      })
      .where(eq(environments.id, environmentId));

    await expect(service.disableTemplate({
      environmentId,
      deleteProviderTemplate: true,
    })).rejects.toThrow("Environment customImage provider changed");

    const deleteCallsAfter = workerManager.call.mock.calls
      .filter(([, method]) => method === "environmentDeleteTemplate")
      .length;
    const [templateRow] = await db
      .select({ status: environmentCustomImageTemplates.status })
      .from(environmentCustomImageTemplates)
      .where(eq(environmentCustomImageTemplates.id, promoted.template.id));

    expect(deleteCallsAfter).toBe(deleteCallsBefore);
    expect(templateRow?.status).toBe("active");
  });

  it("cancels and times out setup sessions without changing the active template", async () => {
    const { environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
    });
    const cancelled = await service.cancelSetupSession({
      sessionId: started.session.id,
      reason: "user_cancelled",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(await service.getActiveTemplate({ environmentId })).toBeNull();

    const expired = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
      ttlSeconds: 60,
      now: new Date("2026-06-25T00:00:00.000Z"),
    });
    const cleanup = await service.cleanupExpiredSetupSessions({
      now: new Date("2026-06-25T00:02:00.000Z"),
    });
    expect(cleanup).toMatchObject({ scanned: 1, timedOut: 1, failed: 0 });
    const timedOut = await service.getSessionById(expired.session.id);
    expect(timedOut?.status).toBe("timed_out");
  });

  it("rejects templates from another environment", async () => {
    const { environmentId } = await seed();
    const otherEnvironmentId = randomUUID();
    await db.insert(environments).values({
      id: otherEnvironmentId,
      name: `Other ${otherEnvironmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:base",
        reuseLease: false,
      },
      envVars: {},
    });
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });
    const [otherTemplate] = await db.insert(environmentCustomImageTemplates).values({
      environmentId: otherEnvironmentId,
      provider: "fake-plugin",
      templateKind: "snapshot",
      templateRef: "snapshot-other-environment",
      status: "active",
    }).returning();

    await expect(service.startSetupSession({
      environmentId,
      templateId: otherTemplate!.id,
      actor: { userId: "user-1" },
    })).rejects.toThrow("Setup template must be the active template");
  });

  it("applies the active template regardless of base-config changes and falls back when none exists", async () => {
    const { companyId, environmentId } = await seed();
    const environment = await db.select().from(environments).where(eq(environments.id, environmentId)).then((rows) => rows[0]!);

    const fallback = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environment.id,
      driver: "sandbox",
      config: environment.config,
    }, { heartbeatRunId: randomUUID() });
    expect(fallback.driver).toBe("sandbox");
    expect(fallback.config).toMatchObject({ image: "fake:base" });

    await db.insert(environmentCustomImageTemplates).values({
      environmentId,
      provider: "fake-plugin",
      templateKind: "snapshot",
      templateRef: "snapshot-active",
      sourceEnvironmentConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(environment.config as any, {
        excludePaths: ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
      }),
      status: "active",
    });
    const resolved = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environment.id,
      driver: "sandbox",
      config: environment.config,
    }, { heartbeatRunId: randomUUID() });
    expect(resolved.driver).toBe("sandbox");
    expect(resolved.config).toMatchObject({ snapshot: "snapshot-active" });
    expect(resolved.config).not.toHaveProperty("image");

    // Runtime-only resource/lease edits must NOT silently discard the captured
    // template.
    await db.update(environments)
      .set({
        config: {
          ...(environment.config as Record<string, unknown>),
          cpu: 4,
          timeoutMs: 600000,
          reuseLease: true,
        },
      })
      .where(eq(environments.id, environment.id));
    const afterResourceChangeEnvironment = await db.select().from(environments).where(eq(environments.id, environmentId)).then((rows) => rows[0]!);
    const afterResourceChange = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: afterResourceChangeEnvironment.id,
      driver: "sandbox",
      config: afterResourceChangeEnvironment.config,
    }, { heartbeatRunId: randomUUID() });
    expect(afterResourceChange.driver).toBe("sandbox");
    expect(afterResourceChange.config).toMatchObject({ snapshot: "snapshot-active" });
    expect(afterResourceChange.config).not.toHaveProperty("image");

    // Changing the base image is a meaningful source-template change. In that
    // case, the old capture must not mask the newly saved image.
    await db.update(environmentCustomImageTemplates)
      .set({
        sourceEnvironmentConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(environment.config as any, {
          excludePaths: ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
        }),
      })
      .where(eq(environmentCustomImageTemplates.templateRef, "snapshot-active"));
    await db.update(environments)
      .set({
        config: {
          ...(environment.config as Record<string, unknown>),
          image: "fake:new-base",
        },
      })
      .where(eq(environments.id, environment.id));
    const afterImageChangeEnvironment = await db.select().from(environments).where(eq(environments.id, environmentId)).then((rows) => rows[0]!);
    const afterImageChange = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: afterImageChangeEnvironment.id,
      driver: "sandbox",
      config: afterImageChangeEnvironment.config,
    }, { heartbeatRunId: randomUUID() });
    expect(afterImageChange.driver).toBe("sandbox");
    expect(afterImageChange.config).toMatchObject({ image: "fake:new-base" });
    expect(afterImageChange.config).not.toHaveProperty("snapshot");
  });

  it("applies the active template for ad-hoc Test probes only when applyCustomImageTemplate is set", async () => {
    const { companyId, environmentId } = await seed();
    const environment = await db.select().from(environments).where(eq(environments.id, environmentId)).then((rows) => rows[0]!);

    await db.insert(environmentCustomImageTemplates).values({
      environmentId,
      provider: "fake-plugin",
      templateKind: "snapshot",
      templateRef: "snapshot-active",
      status: "active",
    });

    // No issueId/heartbeatRunId and no opt-in: an operator Test probe would
    // otherwise silently boot the base image instead of the captured template.
    const withoutOptIn = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environment.id,
      driver: "sandbox",
      config: environment.config,
    });
    expect(withoutOptIn.config).toMatchObject({ image: "fake:base" });
    expect(withoutOptIn.config).not.toHaveProperty("snapshot");

    // The Test route opts in explicitly so the probe uses the captured image.
    const withOptIn = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environment.id,
      driver: "sandbox",
      config: environment.config,
    }, { applyCustomImageTemplate: true });
    expect(withOptIn.config).toMatchObject({ snapshot: "snapshot-active" });
    expect(withOptIn.config).not.toHaveProperty("image");
  });

  it("applies provider-declared runtime config bindings for captured templates", async () => {
    const { companyId, environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
    });
    const promoted = await service.finishSetupSession({ sessionId: started.session.id });

    const environment = await db.select().from(environments).where(eq(environments.id, environmentId)).then((rows) => rows[0]!);
    const resolved = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environment.id,
      driver: "sandbox",
      config: environment.config,
    }, { heartbeatRunId: randomUUID() });

    expect(promoted.template.metadata).toMatchObject({
      runtimeConfigBinding: {
        field: "customTemplate",
        unsetFields: ["image"],
      },
    });
    expect(resolved.driver).toBe("sandbox");
    expect(resolved.config).toMatchObject({ customTemplate: promoted.template.templateRef });
    expect(resolved.config).not.toHaveProperty("image");
    expect(resolved.config).not.toHaveProperty("snapshot");
  });
});

describe("fingerprintEnvironmentSandboxProviderConfig", () => {
  it("ignores excluded secret-ref paths so secretizing a credential on save keeps the fingerprint stable", () => {
    // Mirrors the real flow: a template is captured before "Save Environment"
    // rewrites the raw apiKey into a secret ref. Excluding the secret path must
    // keep the capture-time and run-time fingerprints equal.
    const rawCredential = {
      provider: "daytona",
      image: "daytonaio/sandbox:0.8.0",
      apiKey: "raw-api-key-value",
    } as any;
    const secretRefCredential = {
      provider: "daytona",
      image: "daytonaio/sandbox:0.8.0",
      apiKey: "0d9a7b0e-a3ba-4605-8a68-eb230d494e98",
    } as any;

    const exclude = { excludePaths: ["apiKey"] };
    expect(fingerprintEnvironmentSandboxProviderConfig(rawCredential, exclude)).toBe(
      fingerprintEnvironmentSandboxProviderConfig(secretRefCredential, exclude),
    );

    // Without exclusion the credential change would (incorrectly) invalidate the template.
    expect(fingerprintEnvironmentSandboxProviderConfig(rawCredential)).not.toBe(
      fingerprintEnvironmentSandboxProviderConfig(secretRefCredential),
    );

    // A meaningful base change (e.g. switching the base image) still changes the fingerprint.
    expect(fingerprintEnvironmentSandboxProviderConfig(rawCredential, exclude)).not.toBe(
      fingerprintEnvironmentSandboxProviderConfig(
        { ...rawCredential, image: "daytonaio/sandbox:0.9.0" } as any,
        exclude,
      ),
    );
  });
});

describe("environmentCustomImageTemplateMatchesBaseConfig", () => {
  it("keeps captures across runtime-only edits but not base image changes", () => {
    const baseConfig = {
      provider: "daytona",
      image: "daytonaio/sandbox:0.8.0",
      timeoutMs: 300000,
      reuseLease: false,
    } as any;
    const template = {
      id: "template-1",
      environmentId: "env-1",
      provider: "daytona",
      templateKind: "snapshot",
      templateRef: "snapshot-active",
      sourceTemplateRef: "daytonaio/sandbox:0.8.0",
      sourceEnvironmentConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(baseConfig, {
        excludePaths: ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
      }),
      status: "active",
      createdByUserId: null,
      createdByAgentId: null,
      capturedAt: null,
      lastUsedAt: null,
      supersededByTemplateId: null,
      metadata: null,
      createdAt: new Date("2026-07-09T00:00:00.000Z"),
      updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    } as const;

    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template,
      baseConfig: {
        ...baseConfig,
        timeoutMs: 600000,
        reuseLease: true,
        cpu: 4,
      },
    })).toBe(true);
    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template,
      baseConfig: {
        ...baseConfig,
        image: "daytonaio/sandbox:0.9.0",
      },
    })).toBe(false);
  });

  it("matches configs carrying a secret-ref credential when the capture excluded that path", () => {
    // Capture-time fingerprints exclude the provider's secret-ref paths (e.g.
    // daytona apiKey). The runtime re-check must exclude the same paths or a
    // config with any credential never matches and the template is dropped.
    const baseConfig = {
      provider: "daytona",
      image: "daytonaio/sandbox:0.8.0",
      apiKey: "raw-api-key-value",
    } as any;
    const template = {
      id: "template-1",
      environmentId: "env-1",
      provider: "daytona",
      templateKind: "snapshot",
      templateRef: "snapshot-active",
      sourceTemplateRef: "daytonaio/sandbox:0.8.0",
      sourceEnvironmentConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(baseConfig, {
        excludePaths: [
          ...ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
          "apiKey",
        ],
      }),
      status: "active",
      createdByUserId: null,
      createdByAgentId: null,
      capturedAt: null,
      lastUsedAt: null,
      supersededByTemplateId: null,
      metadata: null,
      createdAt: new Date("2026-07-09T00:00:00.000Z"),
      updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    } as const;

    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template,
      baseConfig,
      secretRefExcludePaths: ["apiKey"],
    })).toBe(true);
    // A rotated credential still matches — credentials are not part of the
    // captured image identity.
    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template,
      baseConfig: { ...baseConfig, apiKey: "rotated-key" },
      secretRefExcludePaths: ["apiKey"],
    })).toBe(true);
    // Without the exclusion the same config fails to match (the pre-fix bug).
    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template,
      baseConfig,
    })).toBe(false);
  });
});

describeEmbeddedPostgres("environmentCustomImageService reconciliation", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-custom-images-reconcile");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(environmentCustomImageSetupSessions);
    await db.delete(environmentCustomImageTemplates);
    await db.delete(plugins);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values(
      { id: companyId, name: "Acme", issuePrefix: `A${companyId.slice(0, 4)}` },
    );
    await db.insert(environments).values({
      id: environmentId,
      name: `Fake ${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:base",
        reuseLease: false,
      },
      envVars: {},
    });
    await db.insert(plugins).values({
      pluginKey: "paperclip.fake-sandbox-provider",
      packageName: "paperclip-plugin-fake-sandbox",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: pluginManifest(),
      status: "ready",
    });
    return { companyId, environmentId };
  }

  it("re-links the active template on save when only non-identity fields change", async () => {
    const { companyId, environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({ environmentId, actor: { userId: "user-1" } });
    const promoted = await service.finishSetupSession({ sessionId: started.session.id });
    const baseConfig = { provider: "fake-plugin", image: "fake:base", reuseLease: false };
    const nextConfig = { ...baseConfig, region: "eu-west" };

    const relinked = await service.reconcileActiveTemplateForConfigChange({
      environmentId,
      previous: { driver: "sandbox", config: baseConfig },
      next: { driver: "sandbox", config: nextConfig },
    });
    expect(relinked.action).toBe("relinked");
    if (relinked.action !== "relinked") throw new Error("expected relink");
    expect(relinked.template.sourceEnvironmentConfigFingerprint)
      .not.toBe(promoted.template.sourceEnvironmentConfigFingerprint);

    // Re-running with the same configs is a no-op: the template already
    // matches the new config.
    const repeat = await service.reconcileActiveTemplateForConfigChange({
      environmentId,
      previous: { driver: "sandbox", config: baseConfig },
      next: { driver: "sandbox", config: nextConfig },
    });
    expect(repeat.action).toBe("none");

    // The captured template keeps applying at runtime under the new config.
    await db.update(environments)
      .set({ config: nextConfig })
      .where(eq(environments.id, environmentId));
    const resolved = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environmentId,
      driver: "sandbox",
      config: nextConfig,
    }, { heartbeatRunId: randomUUID() });
    expect(resolved.driver).toBe("sandbox");
    expect(resolved.config).toMatchObject({ customTemplate: promoted.template.templateRef });
    expect(resolved.config).not.toHaveProperty("image");
  });

  it("reports detached on save when a boot-source or provider identity field changes", async () => {
    const { environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({ environmentId, actor: { userId: "user-1" } });
    const promoted = await service.finishSetupSession({ sessionId: started.session.id });
    const baseConfig = { provider: "fake-plugin", image: "fake:base", reuseLease: false };

    // Base image change: the user asked for a different base, so the capture
    // cannot be re-linked.
    const imageChange = await service.reconcileActiveTemplateForConfigChange({
      environmentId,
      previous: { driver: "sandbox", config: baseConfig },
      next: { driver: "sandbox", config: { ...baseConfig, image: "fake:other" } },
    });
    expect(imageChange.action).toBe("detached");

    // Provider-declared identity path change (apiUrl): captured templates do
    // not exist on a different provider endpoint.
    const endpointChange = await service.reconcileActiveTemplateForConfigChange({
      environmentId,
      previous: { driver: "sandbox", config: baseConfig },
      next: { driver: "sandbox", config: { ...baseConfig, apiUrl: "https://other.example" } },
    });
    expect(endpointChange.action).toBe("detached");

    // Binding-field change counts as a boot-source change too.
    const bindingChange = await service.reconcileActiveTemplateForConfigChange({
      environmentId,
      previous: { driver: "sandbox", config: baseConfig },
      next: { driver: "sandbox", config: { ...baseConfig, customTemplate: "someone-elses-snapshot" } },
    });
    expect(bindingChange.action).toBe("detached");

    // Detach never mutates the stored fingerprint; rollback/disable stay
    // available and the old config still matches.
    const template = await service.getActiveTemplate({ environmentId, provider: "fake-plugin" });
    expect(template?.sourceEnvironmentConfigFingerprint)
      .toBe(promoted.template.sourceEnvironmentConfigFingerprint);

    // A template that was already detached before the save is left alone.
    const alreadyDetached = await service.reconcileActiveTemplateForConfigChange({
      environmentId,
      previous: { driver: "sandbox", config: { ...baseConfig, image: "fake:unrelated" } },
      next: { driver: "sandbox", config: { ...baseConfig, image: "fake:unrelated", region: "eu" } },
    });
    expect(alreadyDetached.action).toBe("none");
  });

  it("reports whether the active template matches the saved config in the overview", async () => {
    const { environmentId } = await seed();
    const workerManager = createWorkerManager();
    const service = environmentCustomImageService(db, { pluginWorkerManager: workerManager });

    const started = await service.startSetupSession({ environmentId, actor: { userId: "user-1" } });
    await service.finishSetupSession({ sessionId: started.session.id });

    const inSync = await service.getOverview({ environmentId });
    expect(inSync.activeTemplateMatchesConfig).toBe(true);

    await db.update(environments)
      .set({ config: { provider: "fake-plugin", image: "fake:other", reuseLease: false } })
      .where(eq(environments.id, environmentId));
    const outOfSync = await service.getOverview({ environmentId });
    expect(outOfSync.activeTemplate).not.toBeNull();
    expect(outOfSync.activeTemplateMatchesConfig).toBe(false);
  });
});
