import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import {
  ACPX_IDENTITY_RECORD_SCHEMA,
  acpxProviderSessionIdentity,
  createAcpxIdentityRecord,
  createAcpxRecoveryBinding,
  verifyExpectedAcpxIdentity,
} from "./recovery-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ACPX recovery identity", () => {
  it("binds the canonical workspace, profile, model, policy, and session", async () => {
    const fixture = await recoveryFixture();
    expect(fixture.binding.runtimeRoot).toContain("session-1-");
    expect(fixture.binding.workspaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fixture.binding.profileSessionKey).toMatch(
      /^paperclip-[0-9a-f]{64}$/,
    );
    expect(fixture.binding.workspacePath).toBe(
      await realpath(fixture.workspace),
    );

    const record = createAcpxIdentityRecord(fixture.expected, fixture.binding);
    expect(record).toMatchObject({
      schema: ACPX_IDENTITY_RECORD_SCHEMA,
      normalizedSessionId: "session-1",
      permissionMode: "approve-reads",
    });
    expect(acpxProviderSessionIdentity(record, fixture.binding)).toEqual({
      kind: "acpx",
      normalizedSessionId: "session-1",
      acpxRecordId: fixture.expected.acpxRecordId,
      backendSessionId: fixture.expected.backendSessionId,
      agentSessionId: fixture.expected.agentSessionId,
      profileDigest: fixture.binding.commandDigest,
      workspaceDigest: fixture.binding.workspaceDigest,
      requestedModel: fixture.binding.requestedModel,
      effectiveModel: fixture.binding.effectiveModel,
      permissionMode: "approve-reads",
      providerLifetimeFenceCandidates: [60_001, 60_002, 60_003],
    });
    expect(() =>
      verifyExpectedAcpxIdentity(fixture.expected, fixture.binding, record),
    ).not.toThrow();
  });

  it("uses collision-resistant roots and policy-bound provider keys", async () => {
    const fixture = await recoveryFixture();
    const otherSession = await createAcpxRecoveryBinding({
      ...fixture.input,
      normalizedSessionId: "session/1",
    });
    const otherPolicy = await createAcpxRecoveryBinding({
      ...fixture.input,
      permissionMode: "deny-all",
    });
    const otherRuntimePackage = await createAcpxRecoveryBinding({
      ...fixture.input,
      profile: {
        ...fixture.input.profile,
        agentRuntimePackage: "@paperclip/test-runtime",
      },
    });
    const otherRuntimeVersion = await createAcpxRecoveryBinding({
      ...fixture.input,
      profile: {
        ...fixture.input.profile,
        agentRuntimeVersion: "99.0.0",
      },
    });

    expect(otherSession.runtimeRoot).not.toBe(fixture.binding.runtimeRoot);
    expect(otherPolicy.profileSessionKey).not.toBe(
      fixture.binding.profileSessionKey,
    );
    expect(otherRuntimePackage.profileDigest).not.toBe(
      fixture.binding.profileDigest,
    );
    expect(otherRuntimePackage.profileSessionKey).not.toBe(
      fixture.binding.profileSessionKey,
    );
    expect(otherRuntimeVersion.profileDigest).not.toBe(
      fixture.binding.profileDigest,
    );
    expect(otherRuntimeVersion.profileSessionKey).not.toBe(
      fixture.binding.profileSessionKey,
    );
  });

  it("rejects immutable workspace, profile, model, and policy drift", async () => {
    const fixture = await recoveryFixture();
    for (const changed of [
      { ...fixture.expected, workspaceDigest: digest("different") },
      { ...fixture.expected, profileDigest: digest("different") },
      { ...fixture.expected, requestedModel: "other" },
      { ...fixture.expected, permissionMode: "deny-all" as const },
      { ...fixture.expected, permissionMode: undefined },
    ]) {
      expect(() =>
        verifyExpectedAcpxIdentity(changed, fixture.binding, null),
      ).toThrow(/immutable session configuration/);
    }
  });

  it("rejects schema-less records that cannot prove session provenance", async () => {
    const fixture = await recoveryFixture();
    const legacy = {
      acpxRecordId: fixture.expected.acpxRecordId,
      backendSessionId: fixture.expected.backendSessionId,
      agentSessionId: fixture.expected.agentSessionId,
      requestedModel: fixture.expected.requestedModel,
      effectiveModel: fixture.expected.effectiveModel,
      profileDigest: fixture.input.profile.commandDigest,
    };
    expect(() =>
      verifyExpectedAcpxIdentity(fixture.expected, fixture.binding, legacy),
    ).toThrow(/Unsupported ACPX identity record schema/);

    const otherBinding = await createAcpxRecoveryBinding({
      ...fixture.input,
      normalizedSessionId: "other-session",
    });
    expect(() =>
      verifyExpectedAcpxIdentity(
        {
          ...fixture.expected,
          normalizedSessionId: otherBinding.normalizedSessionId,
          profileDigest: otherBinding.commandDigest,
          workspaceDigest: otherBinding.workspaceDigest,
        },
        otherBinding,
        legacy,
      ),
    ).toThrow(/Unsupported ACPX identity record schema/);

    const otherWorkspace = join(fixture.root, "other-workspace");
    await mkdir(otherWorkspace);
    const otherWorkspaceBinding = await createAcpxRecoveryBinding({
      ...fixture.input,
      workingDirectory: otherWorkspace,
    });
    expect(() =>
      verifyExpectedAcpxIdentity(
        {
          ...fixture.expected,
          workspaceDigest: otherWorkspaceBinding.workspaceDigest,
        },
        otherWorkspaceBinding,
        legacy,
      ),
    ).toThrow(/Unsupported ACPX identity record schema/);
  });

  it("rejects early v1 command digests across qualified-profile drift", async () => {
    const fixture = await recoveryFixture();
    const earlyV1 = {
      ...createAcpxIdentityRecord(fixture.expected, fixture.binding),
      profileDigest: fixture.input.profile.commandDigest,
    };

    expect(() =>
      verifyExpectedAcpxIdentity(fixture.expected, fixture.binding, earlyV1),
    ).toThrow(/persisted runtime record/);
    const changedBinding = await createAcpxRecoveryBinding({
      ...fixture.input,
      profile: {
        ...fixture.input.profile,
        agentRuntimeVersion: "99.0.0",
      },
    });
    expect(changedBinding.profileDigest).not.toBe(
      fixture.binding.profileDigest,
    );
    expect(changedBinding.commandDigest).toBe(fixture.binding.commandDigest);
    expect(() =>
      verifyExpectedAcpxIdentity(
        {
          ...fixture.expected,
          profileDigest: changedBinding.commandDigest,
        },
        changedBinding,
        earlyV1,
      ),
    ).toThrow(/persisted runtime record/);
  });

  it("rejects malformed records and unsafe workspace roots", async () => {
    const fixture = await recoveryFixture();
    expect(() =>
      verifyExpectedAcpxIdentity(fixture.expected, fixture.binding, {
        ...createAcpxIdentityRecord(fixture.expected, fixture.binding),
        unexpected: true,
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      verifyExpectedAcpxIdentity(fixture.expected, fixture.binding, {
        ...createAcpxIdentityRecord(fixture.expected, fixture.binding),
        schema: "paperclip.runner.acpx-identity.v1",
      }),
    ).toThrow(/Unsupported ACPX identity record schema/);
    const missingPermissionMode = createAcpxIdentityRecord(
      fixture.expected,
      fixture.binding,
    ) as Partial<ReturnType<typeof createAcpxIdentityRecord>>;
    delete missingPermissionMode.permissionMode;
    expect(() =>
      verifyExpectedAcpxIdentity(
        fixture.expected,
        fixture.binding,
        missingPermissionMode,
      ),
    ).toThrow(/permission mode is invalid/);
    const missingFenceCandidates = createAcpxIdentityRecord(
      fixture.expected,
      fixture.binding,
    ) as Partial<ReturnType<typeof createAcpxIdentityRecord>>;
    delete missingFenceCandidates.providerLifetimeFenceCandidates;
    expect(() =>
      verifyExpectedAcpxIdentity(
        fixture.expected,
        fixture.binding,
        missingFenceCandidates,
      ),
    ).toThrow(/lifetime fence candidates are invalid/);
    expect(() =>
      verifyExpectedAcpxIdentity(fixture.expected, fixture.binding, {
        ...createAcpxIdentityRecord(fixture.expected, fixture.binding),
        providerLifetimeFenceCandidates: [60_001, 60_002, 60_004],
      }),
    ).toThrow(/does not match the persisted runtime record/);

    await expect(
      createAcpxRecoveryBinding({
        ...fixture.input,
        workingDirectory: parse(fixture.workspace).root,
      }),
    ).rejects.toThrow(/non-root directory/);
    const file = join(fixture.root, "file");
    await writeFile(file, "not a directory");
    await expect(
      createAcpxRecoveryBinding({
        ...fixture.input,
        workingDirectory: file,
      }),
    ).rejects.toThrow(/non-root directory/);
  });
});

async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-recovery-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const runtimeDirectory = join(root, "runtime");
  await Promise.all([mkdir(workspace), mkdir(runtimeDirectory)]);
  const profile = resolveQualifiedAcpxProfile("claude", "claude-sonnet-5");
  const input = {
    runtimeDirectory,
    normalizedSessionId: "session-1",
    workingDirectory: workspace,
    profile,
    requestedModel: "claude-sonnet-5",
    permissionMode: "approve-reads" as const,
  };
  const binding = await createAcpxRecoveryBinding(input);
  const expected = {
    kind: "acpx" as const,
    normalizedSessionId: input.normalizedSessionId,
    acpxRecordId: "record-1",
    backendSessionId: "backend-1",
    agentSessionId: "agent-1",
    profileDigest: binding.commandDigest,
    workspaceDigest: binding.workspaceDigest,
    requestedModel: binding.requestedModel,
    effectiveModel: binding.effectiveModel,
    permissionMode: binding.permissionMode,
    providerLifetimeFenceCandidates: [60_001, 60_002, 60_003] as const,
  };
  return { root, workspace, input, binding, expected };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
