import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvironmentConfig,
} from "@paperclipai/adapter-utils/ssh";
import {
  agents,
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping environment runtime driver contract tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface RuntimeContractCase {
  name: string;
  driver: string;
  config: Record<string, unknown>;
  setup?: () => Promise<() => Promise<void>>;
  expectLease: (lease: {
    providerLeaseId: string | null;
    metadata: Record<string, unknown> | null;
  }, environment: Environment) => void;
}

describeEmbeddedPostgres("environment runtime driver contract", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const fixtureRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime-contract");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment(input: {
    driver: string;
    config: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    let config = input.config;

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Contract Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) {
      const secret = await secretService(db).create(companyId, {
        name: `environment-contract-private-key-${randomUUID()}`,
        provider: "local_encrypted",
        value: config.privateKey,
      });
      await secretService(db).createBinding({
        companyId,
        secretId: secret.id,
        targetType: "environment",
        targetId: environmentId,
        configPath: "privateKeySecretRef",
      });
      config = {
        ...config,
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      };
    }
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: `${input.driver} contract`,
      driver: input.driver,
      status: "active",
      config,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    return {
      companyId,
      issueId: null,
      runId,
      environment: {
        id: environmentId,
        companyId,
        name: `${input.driver} contract`,
        description: null,
        driver: input.driver,
        status: "active",
        config,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      } as Environment,
    };
  }

  async function runContract(testCase: RuntimeContractCase) {
    const cleanup = await testCase.setup?.();
    try {
      const runtime = environmentRuntimeService(db);
      const { companyId, environment, issueId, runId } = await seedEnvironment({
        driver: testCase.driver,
        config: testCase.config,
      });

      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });

      expect(acquired.environment.id).toBe(environment.id);
      expect(acquired.lease.companyId).toBe(companyId);
      expect(acquired.lease.environmentId).toBe(environment.id);
      expect(acquired.lease.issueId).toBeNull();
      expect(acquired.lease.heartbeatRunId).toBe(runId);
      expect(acquired.lease.status).toBe("active");
      expect(acquired.leaseContext).toEqual({
        executionWorkspaceId: null,
        executionWorkspaceMode: null,
      });
      expect(acquired.lease.metadata).toMatchObject({
        driver: testCase.driver,
        executionWorkspaceMode: null,
      });
      testCase.expectLease(acquired.lease, environment);

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.id).toBe(environment.id);
      expect(released[0]?.lease.id).toBe(acquired.lease.id);
      expect(released[0]?.lease.status).toBe("released");

      const activeRows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.status, "active"));
      expect(activeRows).toHaveLength(0);
      await expect(runtime.releaseRunLeases(runId)).resolves.toEqual([]);
    } finally {
      await cleanup?.();
    }
  }

  const contractCases: RuntimeContractCase[] = [
    {
      name: "local",
      driver: "local",
      config: {},
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toBeNull();
      },
    },
    {
      name: "fake sandbox",
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: false,
      },
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toMatch(/^sandbox:\/\/fake\/[0-9a-f-]+\/[0-9a-f-]+$/);
        expect(lease.metadata).toMatchObject({
          provider: "fake",
          image: "ubuntu:24.04",
          reuseLease: false,
        });
      },
    },
  ];

  for (const testCase of contractCases) {
    it(`${testCase.name} satisfies the acquire/release host contract`, async () => {
      await runContract(testCase);
    });
  }

  it("SSH satisfies the acquire/release host contract", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(`Skipping SSH driver contract test: ${sshFixtureSupport.reason ?? "unsupported environment"}`);
      return;
    }

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-env-runtime-contract-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);

    await runContract({
      name: "ssh",
      driver: "ssh",
      config: sshConfig as SshEnvironmentConfig as unknown as Record<string, unknown>,
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toContain(`ssh://${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);
        expect(lease.metadata).toMatchObject({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          remoteWorkspacePath: sshConfig.remoteWorkspacePath,
          remoteCwd: sshConfig.remoteWorkspacePath,
        });
      },
    });
  });
});
