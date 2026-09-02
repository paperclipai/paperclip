import type { Db } from "@paperclipai/db";
import { describe, expect, it } from "vitest";

import {
  computeManagedAgentProfileRevision,
  managedAgentProfileService,
} from "./managed-agent-profiles.js";
import {
  computeRemoteAgentProfileRevision,
  remoteAgentProfileService,
  type RemoteAgentProfileInput,
} from "./remote-agent-profiles.js";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY_SECRET_ID = "20000000-0000-4000-8000-000000000002";

const AWS_CONFIGURATION = {
  region: "us-east-1",
  accountId: "123456789012",
  harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/example",
  harnessVersion: "1",
  endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/example",
  endpointQualifier: "paperclip",
  agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
  memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/example",
  memoryId: "memory-example",
  invocationRoleArn: "arn:aws:iam::123456789012:role/paperclip-runner",
  contextBucket: "paperclip-runner-context",
  contextPrefix: "profiles/example",
  contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/example",
  qualificationRevision: "aws-agentcore-harness-v1",
  defaultModel: "global.anthropic.claude-sonnet-4-6",
  eventExpiryDays: 90,
  defaultMaxEstimatedSessionCostUsd: 1,
} as const;

function remoteInput(
  overrides: Partial<RemoteAgentProfileInput> = {},
): RemoteAgentProfileInput {
  return {
    profileKey: "agentcore",
    displayName: "AgentCore",
    service: "aws_bedrock_agentcore_harness",
    configuration: { ...AWS_CONFIGURATION },
    enabled: false,
    retentionAcknowledged: false,
    qualification: { suite: "aws-agentcore-harness-v1" },
    ...overrides,
  };
}

function dbReturningNoRows(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  } as unknown as Db;
}

function dbReturningFirstRow(row: Record<string, unknown>): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    }),
  } as unknown as Db;
}

function dbForUpsert(
  existing: Record<string, unknown> | null,
  secretId?: string,
): Db {
  let selection = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selection += 1;
            if (selection === 1) return existing ? [existing] : [];
            return secretId ? [{ id: secretId }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ ...(existing ?? {}), ...values }],
        }),
      }),
    }),
  } as unknown as Db;
}

const unusedDb = new Proxy({}, {
  get() {
    throw new Error("validation unexpectedly accessed the database");
  },
}) as unknown as Db;

describe("remote agent profile metadata validation", () => {
  it("rejects obsolete explicit credentials because AgentCore uses workload identity", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(COMPANY_ID, {
        ...remoteInput(),
        credentialSecretId: OTHER_COMPANY_SECRET_ID,
      } as unknown as RemoteAgentProfileInput),
    ).rejects.toThrow("use workload identity");
  });

  it("rejects Claude profiles before the remote AgentCore store is accessed", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(COMPANY_ID, {
        ...remoteInput(),
        service: "anthropic_managed_agents",
      } as unknown as RemoteAgentProfileInput),
    ).rejects.toThrow("Unsupported remote agent service");
  });

  it("rejects non-canonical Anthropic Agent versions before profile storage", async () => {
    for (const agentVersion of ["latest", "0", "01", "2147483648"]) {
      await expect(
        managedAgentProfileService(unusedDb).upsert(COMPANY_ID, {
          profileKey: "managed",
          displayName: "Managed Agent",
          anthropicAgentId: "agent-example",
          agentVersion,
          environmentId: "environment-example",
          defaultModel: "claude-sonnet-5",
          defaultMaxListCostUsd: 1,
          apiKeySecretId: OTHER_COMPANY_SECRET_ID,
          enabled: false,
          retentionAcknowledged: false,
        }),
      ).rejects.toThrow("canonical positive 32-bit integer");
    }
  });

  it("rejects provider configuration keys outside the exact allowlist", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          configuration: {
            ...AWS_CONFIGURATION,
            customEndpointToken: "not-persistable",
          },
        }),
      ),
    ).rejects.toThrow("Unsupported configuration field");
  });

  it("rejects secret-shaped configuration values and qualification fields", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          configuration: {
            ...AWS_CONFIGURATION,
            qualificationRevision: "Bearer secret-value",
          },
        }),
      ),
    ).rejects.toThrow("must not contain credential-shaped keys or values");

    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({ qualification: { apiToken: "secret-value" } }),
      ),
    ).rejects.toThrow("must not contain credential-shaped keys or values");

    await expect(
      managedAgentProfileService(unusedDb).upsert(COMPANY_ID, {
        profileKey: "managed",
        displayName: "Bearer secret-value",
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostUsd: 1,
        apiKeySecretId: OTHER_COMPANY_SECRET_ID,
        enabled: false,
        retentionAcknowledged: false,
      }),
    ).rejects.toThrow("must not contain credential-shaped keys or values");
  });

  it("requires retention acknowledgement and a positive explicit spend ceiling", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({ enabled: true, retentionAcknowledged: false }),
      ),
    ).rejects.toThrow("requires retention acknowledgement");

    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          configuration: {
            ...AWS_CONFIGURATION,
            defaultMaxEstimatedSessionCostUsd: 0,
          },
        }),
      ),
    ).rejects.toThrow("spend ceiling must be positive");

    const {
      defaultMaxEstimatedSessionCostUsd: _omittedSpendCeiling,
      ...configurationWithoutSpendCeiling
    } = AWS_CONFIGURATION;
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({ configuration: configurationWithoutSpendCeiling }),
      ),
    ).rejects.toThrow("spend ceiling must be positive");

    await expect(
      managedAgentProfileService(unusedDb).upsert(COMPANY_ID, {
        profileKey: "managed",
        displayName: "Managed Agent",
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostUsd: 0,
        apiKeySecretId: OTHER_COMPANY_SECRET_ID,
        enabled: false,
        retentionAcknowledged: false,
      }),
    ).rejects.toThrow("spend ceiling must be positive");
  });

  it("does not treat enablement or arbitrary metadata as qualification", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({ enabled: true, retentionAcknowledged: true, qualification: {} }),
      ),
    ).rejects.toThrow("qualification attestation is required");

    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          enabled: true,
          retentionAcknowledged: true,
          qualification: { suite: "operator-says-pass" },
        }),
      ),
    ).rejects.toThrow("does not match the qualified harness suite");

    await expect(
      managedAgentProfileService(unusedDb).upsert(COMPANY_ID, {
        profileKey: "managed",
        displayName: "Managed Agent",
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostUsd: 1,
        apiKeySecretId: OTHER_COMPANY_SECRET_ID,
        enabled: true,
        retentionAcknowledged: true,
        qualification: {},
      }),
    ).rejects.toThrow("qualification attestation is required");
  });

  it("stores a qualified revision only after exact operator attestation", async () => {
    const qualification = {
      probedAt: "2026-08-01T00:00:00.000Z",
      betaVersion: "managed-agents-2026-04-01",
      environmentPolicy: "limited_no_hosts_no_packages",
      agentCapabilities: "no_tools_no_mcp_no_skills_no_multiagent",
    };
    const managed = await managedAgentProfileService(
      dbForUpsert(null, OTHER_COMPANY_SECRET_ID),
    ).upsert(COMPANY_ID, {
      profileKey: "managed",
      displayName: "Managed Agent",
      anthropicAgentId: "agent-example",
      agentVersion: "1",
      environmentId: "environment-example",
      defaultModel: "claude-sonnet-5",
      defaultMaxListCostUsd: 1,
      apiKeySecretId: OTHER_COMPANY_SECRET_ID,
      enabled: true,
      retentionAcknowledged: true,
      qualification,
    });
    expect(managed.qualifiedAt).toBeInstanceOf(Date);
    expect(managed.qualifiedRevision).toMatch(/^sha256:[0-9a-f]{64}$/);

    const remote = await remoteAgentProfileService(dbForUpsert(null)).upsert(
      COMPANY_ID,
      remoteInput({ enabled: true, retentionAcknowledged: true }),
    );
    expect(remote.qualifiedAt).toBeInstanceOf(Date);
    expect(remote.qualifiedRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("requires exact qualified models and non-UUID profile keys", async () => {
    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({
          configuration: { ...AWS_CONFIGURATION, defaultModel: "claude-sonnet-4-6" },
        }),
      ),
    ).rejects.toThrow("model must be global.anthropic.claude-sonnet-4-6");

    await expect(
      managedAgentProfileService(unusedDb).upsert(COMPANY_ID, {
        profileKey: "managed",
        displayName: "Managed Agent",
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        defaultModel: "claude-opus-5",
        defaultMaxListCostUsd: 1,
        apiKeySecretId: OTHER_COMPANY_SECRET_ID,
        enabled: false,
        retentionAcknowledged: false,
      }),
    ).rejects.toThrow("model must be claude-sonnet-5");

    await expect(
      remoteAgentProfileService(unusedDb).upsert(
        COMPANY_ID,
        remoteInput({ profileKey: "30000000-0000-4000-8000-000000000003" }),
      ),
    ).rejects.toThrow("must not be UUID-shaped");
  });

  it("rejects Claude credential references that do not resolve in the owning company", async () => {
    await expect(
      managedAgentProfileService(dbReturningNoRows()).upsert(COMPANY_ID, {
        profileKey: "managed",
        displayName: "Managed Agent",
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostUsd: 1,
        apiKeySecretId: OTHER_COMPANY_SECRET_ID,
        enabled: false,
        retentionAcknowledged: false,
        qualification: {},
      }),
    ).rejects.toThrow("API-key secret reference is invalid");
  });

  it("does not allow a qualified AgentCore profile key to be repointed", async () => {
    const qualification = { suite: "aws-agentcore-harness-v1" };
    const existing = {
      id: "30000000-0000-4000-8000-000000000003",
      companyId: COMPANY_ID,
      profileKey: "agentcore",
      displayName: "AgentCore",
      service: "aws_bedrock_agentcore_harness",
      configuration: { ...AWS_CONFIGURATION },
      enabled: true,
      retentionAcknowledged: true,
      qualification,
      qualifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      qualifiedRevision: computeRemoteAgentProfileRevision({
        service: "aws_bedrock_agentcore_harness",
        configuration: AWS_CONFIGURATION,
        retentionAcknowledged: true,
        qualification,
      }),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };

    await expect(
      remoteAgentProfileService(dbReturningFirstRow(existing)).upsert(
        COMPANY_ID,
        remoteInput({
          enabled: true,
          retentionAcknowledged: true,
          configuration: { ...AWS_CONFIGURATION, memoryId: "different-memory" },
        }),
      ),
    ).rejects.toThrow("configuration revision is immutable");
  });

  it("does not allow qualified Claude resource identity or proof to drift", async () => {
    const qualification = {
      probedAt: "2026-08-01T00:00:00.000Z",
      betaVersion: "managed-agents-2026-04-01",
      environmentPolicy: "limited_no_hosts_no_packages",
      agentCapabilities: "no_tools_no_mcp_no_skills_no_multiagent",
    };
    const existing = {
      id: "30000000-0000-4000-8000-000000000004",
      companyId: COMPANY_ID,
      profileKey: "managed",
      displayName: "Managed Agent",
      service: "anthropic_managed_agents",
      anthropicAgentId: "agent-example",
      agentVersion: "1",
      environmentId: "environment-example",
      betaVersion: "managed-agents-2026-04-01",
      defaultModel: "claude-sonnet-5",
      defaultMaxListCostCents: 100,
      apiKeySecretId: OTHER_COMPANY_SECRET_ID,
      enabled: true,
      retentionAcknowledged: true,
      qualification,
      qualifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      qualifiedRevision: computeManagedAgentProfileRevision({
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        betaVersion: "managed-agents-2026-04-01",
        retentionAcknowledged: true,
        qualification,
      }),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };

    await expect(
      managedAgentProfileService(dbReturningFirstRow(existing)).upsert(COMPANY_ID, {
        profileKey: "managed",
        displayName: "Managed Agent",
        anthropicAgentId: "different-agent",
        agentVersion: "1",
        environmentId: "environment-example",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostUsd: 1,
        apiKeySecretId: OTHER_COMPANY_SECRET_ID,
        enabled: true,
        retentionAcknowledged: true,
        qualification,
      }),
    ).rejects.toThrow("configuration revision is immutable");
  });

  it("allows credential rotation and mutable caps without invalidating qualified identity", async () => {
    const qualification = {
      probedAt: "2026-08-01T00:00:00.000Z",
      betaVersion: "managed-agents-2026-04-01",
      environmentPolicy: "limited_no_hosts_no_packages",
      agentCapabilities: "no_tools_no_mcp_no_skills_no_multiagent",
    };
    const rotatedSecretId = "20000000-0000-4000-8000-000000000003";
    const existingManaged = {
      id: "30000000-0000-4000-8000-000000000004",
      companyId: COMPANY_ID,
      profileKey: "managed",
      displayName: "Managed Agent",
      service: "anthropic_managed_agents",
      anthropicAgentId: "agent-example",
      agentVersion: "1",
      environmentId: "environment-example",
      betaVersion: "managed-agents-2026-04-01",
      defaultModel: "claude-sonnet-5",
      defaultMaxListCostCents: 100,
      apiKeySecretId: OTHER_COMPANY_SECRET_ID,
      enabled: true,
      retentionAcknowledged: true,
      qualification,
      qualifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      qualifiedRevision: computeManagedAgentProfileRevision({
        anthropicAgentId: "agent-example",
        agentVersion: "1",
        environmentId: "environment-example",
        betaVersion: "managed-agents-2026-04-01",
        retentionAcknowledged: true,
        qualification,
      }),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const updatedManaged = await managedAgentProfileService(
      dbForUpsert(existingManaged, rotatedSecretId),
    ).upsert(COMPANY_ID, {
      profileKey: "managed",
      displayName: "Managed Agent",
      anthropicAgentId: "agent-example",
      agentVersion: "1",
      environmentId: "environment-example",
      defaultModel: "claude-sonnet-5",
      defaultMaxListCostUsd: 2.5,
      apiKeySecretId: rotatedSecretId,
      enabled: true,
      retentionAcknowledged: true,
      qualification,
    });
    expect(updatedManaged).toMatchObject({
      apiKeySecretId: rotatedSecretId,
      defaultMaxListCostCents: 250,
      qualifiedRevision: existingManaged.qualifiedRevision,
    });

    const awsQualification = { suite: "aws-agentcore-harness-v1" };
    const existingRemote = {
      id: "30000000-0000-4000-8000-000000000005",
      companyId: COMPANY_ID,
      profileKey: "agentcore",
      displayName: "AgentCore",
      service: "aws_bedrock_agentcore_harness",
      configuration: { ...AWS_CONFIGURATION },
      enabled: true,
      retentionAcknowledged: true,
      qualification: awsQualification,
      qualifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      qualifiedRevision: computeRemoteAgentProfileRevision({
        service: "aws_bedrock_agentcore_harness",
        configuration: AWS_CONFIGURATION,
        retentionAcknowledged: true,
        qualification: awsQualification,
      }),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const updatedRemote = await remoteAgentProfileService(
      dbForUpsert(existingRemote),
    ).upsert(COMPANY_ID, remoteInput({
      enabled: true,
      retentionAcknowledged: true,
      configuration: {
        ...AWS_CONFIGURATION,
        defaultMaxEstimatedSessionCostUsd: 3,
      },
    }));
    expect(updatedRemote).toMatchObject({
      configuration: {
        defaultModel: "global.anthropic.claude-sonnet-4-6",
        defaultMaxEstimatedSessionCostUsd: 3,
      },
      qualifiedRevision: existingRemote.qualifiedRevision,
    });
  });

  it("rejects runtime use when stored identity drifts from the qualified revision", async () => {
    const qualification = { suite: "aws-agentcore-harness-v1" };
    const qualifiedRevision = computeRemoteAgentProfileRevision({
      service: "aws_bedrock_agentcore_harness",
      configuration: AWS_CONFIGURATION,
      retentionAcknowledged: true,
      qualification,
    });
    await expect(
      remoteAgentProfileService(dbReturningFirstRow({
        id: "30000000-0000-4000-8000-000000000003",
        companyId: COMPANY_ID,
        profileKey: "agentcore",
        displayName: "AgentCore",
        service: "aws_bedrock_agentcore_harness",
        configuration: { ...AWS_CONFIGURATION, memoryId: "tampered-memory" },
        enabled: true,
        retentionAcknowledged: true,
        qualification,
        qualifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        qualifiedRevision,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      })).requireQualified(COMPANY_ID, "agentcore"),
    ).rejects.toThrow("does not match its qualified revision");
  });
});
