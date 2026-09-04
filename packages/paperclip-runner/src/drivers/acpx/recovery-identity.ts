import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { AcpxExpectedSessionIdentity } from "./sidecar-protocol.js";
import type { QualifiedAcpxProfile } from "./qualified-profiles.js";

export const ACPX_IDENTITY_RECORD_SCHEMA =
  "paperclip.runner.acpx-identity.v2" as const;

export interface AcpxRecoveryBinding {
  normalizedSessionId: string;
  workspacePath: string;
  workspaceDigest: string;
  runtimeRoot: string;
  commandDigest: string;
  profileDigest: string;
  requestedModel: string;
  effectiveModel: string;
  permissionMode: NativeAcpxPermissionMode;
  profileSessionKey: string;
}

export interface AcpxIdentityRecord {
  schema: typeof ACPX_IDENTITY_RECORD_SCHEMA;
  normalizedSessionId: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  profileDigest: string;
  workspaceDigest: string;
  requestedModel: string;
  effectiveModel: string;
  permissionMode: NativeAcpxPermissionMode;
  providerLifetimeFenceCandidates: readonly [number, number, number];
}

export async function createAcpxRecoveryBinding(input: {
  runtimeDirectory: string;
  normalizedSessionId: string;
  workingDirectory: string;
  profile: QualifiedAcpxProfile;
  requestedModel: string;
  permissionMode: NativeAcpxPermissionMode;
}): Promise<AcpxRecoveryBinding> {
  validateIdentity(input.normalizedSessionId, "normalized session");
  if (input.requestedModel !== input.profile.qualificationModel) {
    throw new Error("ACPX recovery requested an unqualified model");
  }
  if (!isDigest(input.profile.commandDigest)) {
    throw new Error("ACPX recovery profile command digest is invalid");
  }
  const workspacePath = await resolveWorkspace(input.workingDirectory);
  const workspaceDigest = digest(workspacePath);
  const runtimeRoot = await resolveAcpxRuntimeRoot(
    input.runtimeDirectory,
    input.normalizedSessionId,
  );
  const profileDigest = digest(
    canonicalJson({
      driverKind: input.profile.driverKind,
      protocolVersion: input.profile.protocolVersion,
      acpxVersion: input.profile.acpxVersion,
      agent: input.profile.agent,
      agentProfileVersion: input.profile.agentProfileVersion,
      agentServerPackage: input.profile.agentServerPackage,
      agentServerVersion: input.profile.agentServerVersion,
      agentRuntimePackage: input.profile.agentRuntimePackage,
      agentRuntimeVersion: input.profile.agentRuntimeVersion,
      commandDigest: input.profile.commandDigest,
      qualificationModel: input.profile.qualificationModel,
      reportedModelId: input.profile.reportedModelId,
      permissionPolicy: input.profile.permissionPolicy,
    }),
  );
  const profileSessionKey = digest(
    canonicalJson({
      normalizedSessionId: input.normalizedSessionId,
      workspacePath,
      workspaceDigest,
      requestedModel: input.requestedModel,
      profileDigest,
      permissionMode: input.permissionMode,
    }),
  ).replace("sha256:", "paperclip-");
  return {
    normalizedSessionId: input.normalizedSessionId,
    workspacePath,
    workspaceDigest,
    runtimeRoot,
    commandDigest: input.profile.commandDigest,
    profileDigest,
    requestedModel: input.requestedModel,
    effectiveModel: input.requestedModel,
    permissionMode: input.permissionMode,
    profileSessionKey,
  };
}

export function createAcpxIdentityRecord(
  expected: AcpxExpectedSessionIdentity,
  binding: AcpxRecoveryBinding,
): AcpxIdentityRecord {
  verifyExpectedAcpxIdentity(expected, binding, null);
  return {
    schema: ACPX_IDENTITY_RECORD_SCHEMA,
    normalizedSessionId: binding.normalizedSessionId,
    acpxRecordId: expected.acpxRecordId,
    backendSessionId: expected.backendSessionId,
    agentSessionId: expected.agentSessionId,
    profileDigest: binding.profileDigest,
    workspaceDigest: binding.workspaceDigest,
    requestedModel: binding.requestedModel,
    effectiveModel: binding.effectiveModel,
    permissionMode: binding.permissionMode,
    providerLifetimeFenceCandidates: Object.freeze([
      ...expected.providerLifetimeFenceCandidates,
    ]) as readonly [number, number, number],
  };
}

/** Project the private persisted record into the PRP sidecar wire identity. */
export function acpxProviderSessionIdentity(
  record: AcpxIdentityRecord,
  binding: AcpxRecoveryBinding,
): AcpxExpectedSessionIdentity {
  const identity: AcpxExpectedSessionIdentity = {
    kind: "acpx",
    normalizedSessionId: record.normalizedSessionId,
    acpxRecordId: record.acpxRecordId,
    backendSessionId: record.backendSessionId,
    agentSessionId: record.agentSessionId,
    // The PRP provider contract historically names this field
    // `profileDigest`, but it attests the qualified executable digest. Keep
    // the broader immutable-profile digest private in the persisted record.
    profileDigest: binding.commandDigest,
    workspaceDigest: record.workspaceDigest,
    requestedModel: record.requestedModel,
    effectiveModel: record.effectiveModel,
    permissionMode: record.permissionMode,
    providerLifetimeFenceCandidates: record.providerLifetimeFenceCandidates,
  };
  verifyExpectedAcpxIdentity(identity, binding, record);
  return identity;
}

/**
 * Verify both the controller-provided identity and a persisted runtime record.
 * Only the complete v2 record is recoverable. Draft schema-less and
 * command-digest records cannot prove every immutable session binding, so
 * callers must fail closed and start a fresh provider session for them.
 */
export function verifyExpectedAcpxIdentity(
  expected: AcpxExpectedSessionIdentity,
  binding: AcpxRecoveryBinding,
  persisted: unknown,
): void {
  validateExpected(expected);
  if (
    expected.normalizedSessionId !== binding.normalizedSessionId ||
    expected.profileDigest !== binding.commandDigest ||
    expected.workspaceDigest !== binding.workspaceDigest ||
    expected.requestedModel !== binding.requestedModel ||
    expected.effectiveModel !== binding.effectiveModel ||
    expected.permissionMode !== binding.permissionMode
  ) {
    throw new Error(
      "ACPX recovery identity conflicts with the immutable session configuration",
    );
  }
  if (persisted === null) return;

  const record = parsePersistedRecord(persisted);
  if (
    record.acpxRecordId !== expected.acpxRecordId ||
    record.backendSessionId !== expected.backendSessionId ||
    record.agentSessionId !== expected.agentSessionId ||
    record.normalizedSessionId !== binding.normalizedSessionId ||
    record.profileDigest !== binding.profileDigest ||
    record.workspaceDigest !== binding.workspaceDigest ||
    record.requestedModel !== binding.requestedModel ||
    record.effectiveModel !== binding.effectiveModel ||
    record.permissionMode !== binding.permissionMode ||
    !sameFenceCandidates(
      record.providerLifetimeFenceCandidates,
      expected.providerLifetimeFenceCandidates,
    )
  ) {
    throw new Error(
      "ACPX recovery identity does not match the persisted runtime record",
    );
  }
}

function parsePersistedRecord(value: unknown): AcpxIdentityRecord {
  const record = object(value);
  rejectUnknownKeys(record, [
    "schema",
    "normalizedSessionId",
    "acpxRecordId",
    "backendSessionId",
    "agentSessionId",
    "profileDigest",
    "workspaceDigest",
    "requestedModel",
    "effectiveModel",
    "permissionMode",
    "providerLifetimeFenceCandidates",
  ]);
  return validatedRecord(record);
}

function validatedRecord(value: Record<string, unknown>): AcpxIdentityRecord {
  if (value.schema !== ACPX_IDENTITY_RECORD_SCHEMA) {
    throw new Error("Unsupported ACPX identity record schema");
  }
  for (const field of [
    "normalizedSessionId",
    "acpxRecordId",
    "backendSessionId",
    "agentSessionId",
    "requestedModel",
    "effectiveModel",
  ] as const) {
    validateIdentity(value[field], field);
  }
  for (const field of ["profileDigest", "workspaceDigest"] as const) {
    if (!isDigest(value[field]))
      throw new Error(`ACPX identity ${field} is invalid`);
  }
  if (!isPermissionMode(value.permissionMode)) {
    throw new Error("ACPX identity permission mode is invalid");
  }
  validateFenceCandidates(value.providerLifetimeFenceCandidates);
  return value as unknown as AcpxIdentityRecord;
}

function validateExpected(expected: AcpxExpectedSessionIdentity): void {
  if (expected.kind !== "acpx") throw new Error("Expected ACPX identity kind");
  for (const value of [
    expected.normalizedSessionId,
    expected.acpxRecordId,
    expected.backendSessionId,
    expected.agentSessionId,
    expected.requestedModel,
    expected.effectiveModel,
  ]) {
    validateIdentity(value, "expected ACPX");
  }
  if (
    !isDigest(expected.profileDigest) ||
    !isDigest(expected.workspaceDigest)
  ) {
    throw new Error("Expected ACPX identity digest is invalid");
  }
  if (
    expected.permissionMode !== undefined &&
    !isPermissionMode(expected.permissionMode)
  ) {
    throw new Error("Expected ACPX permission mode is invalid");
  }
  validateFenceCandidates(expected.providerLifetimeFenceCandidates);
}

function validateFenceCandidates(
  value: unknown,
): asserts value is readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (port) => !Number.isSafeInteger(port) || port < 49_152 || port > 65_535,
    ) ||
    new Set(value).size !== 3
  ) {
    throw new Error("ACPX provider lifetime fence candidates are invalid");
  }
}

function sameFenceCandidates(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): boolean {
  return left.every((port, index) => port === right[index]);
}

async function resolveWorkspace(value: string): Promise<string> {
  if (!value.trim()) throw new Error("ACPX working directory is required");
  const workspacePath = await realpath(value);
  const metadata = await stat(workspacePath);
  if (!metadata.isDirectory() || workspacePath === dirname(workspacePath)) {
    throw new Error("ACPX working directory must be a non-root directory");
  }
  return workspacePath;
}

export async function resolveAcpxRuntimeRoot(
  runtimeDirectory: string,
  sessionId: string,
): Promise<string> {
  if (!runtimeDirectory.trim())
    throw new Error("ACPX runtime directory is required");
  const root = await realpath(runtimeDirectory);
  const metadata = await stat(root);
  if (!metadata.isDirectory())
    throw new Error("ACPX runtime directory must be a directory");
  if (root === dirname(root))
    throw new Error("ACPX runtime directory must not be a filesystem root");
  const readable = sessionId
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+$/, "session")
    .slice(0, 80);
  const suffix = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return join(resolve(root), "acpx", `${readable || "session"}-${suffix}`);
}

function validateIdentity(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} identity is missing or invalid`);
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isPermissionMode(value: unknown): value is NativeAcpxPermissionMode {
  return (
    typeof value === "string" &&
    ["approve-all", "approve-reads", "deny-all"].includes(value)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const names = new Set(allowed);
  if (Object.keys(value).some((key) => !names.has(key))) {
    throw new Error("ACPX identity record contains an unknown field");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ACPX identity record must be an object");
  }
  return value as Record<string, unknown>;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}
