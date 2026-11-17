import { and, eq, gt, lt } from "drizzle-orm";
import { companySecretDeploymentAssertions, companySecretVersions, type Db } from "@paperclipai/db";
import { conflict, forbidden, unprocessable } from "../errors.js";

export const DEPLOYMENT_ASSERTION_TTL_MS = 30 * 60 * 1000;

export type DeploymentAssertion = typeof companySecretDeploymentAssertions.$inferSelect;

export type RegisterDeploymentAssertionInput = {
  companyId: string;
  secretId: string;
  expectedLatestVersion: number;
  valueFingerprintSha256: string;
  previousValueFingerprintSha256: string;
  deploymentLabel: string;
  assertedByAgentId?: string | null;
  originRunId?: string | null;
  originIssueId?: string | null;
};

export function secretDeploymentAssertionService(db: Db) {
  async function currentVersionFingerprint(secretId: string, version: number) {
    return db
      .select({ fingerprintSha256: companySecretVersions.fingerprintSha256 })
      .from(companySecretVersions)
      .where(and(
        eq(companySecretVersions.secretId, secretId),
        eq(companySecretVersions.version, version),
      ))
      .then((rows) => rows[0]?.fingerprintSha256 ?? null);
  }

  async function get(id: string) {
    return db
      .select()
      .from(companySecretDeploymentAssertions)
      .where(eq(companySecretDeploymentAssertions.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function register(input: RegisterDeploymentAssertionInput) {
    const [row] = await db
      .insert(companySecretDeploymentAssertions)
      .values({
        companyId: input.companyId,
        secretId: input.secretId,
        expectedLatestVersion: input.expectedLatestVersion,
        valueFingerprintSha256: input.valueFingerprintSha256,
        previousValueFingerprintSha256: input.previousValueFingerprintSha256,
        deploymentLabel: input.deploymentLabel,
        assertedByAgentId: input.assertedByAgentId ?? null,
        originRunId: input.originRunId ?? null,
        originIssueId: input.originIssueId ?? null,
        status: "pending",
        expiresAt: new Date(Date.now() + DEPLOYMENT_ASSERTION_TTL_MS),
      })
      .returning();
    return row;
  }

  async function expireIfDue(id: string) {
    const [row] = await db
      .update(companySecretDeploymentAssertions)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(
        eq(companySecretDeploymentAssertions.id, id),
        eq(companySecretDeploymentAssertions.status, "pending"),
        lt(companySecretDeploymentAssertions.expiresAt, new Date()),
      ))
      .returning();
    return row ?? null;
  }

  async function consume(id: string) {
    const [row] = await db
      .update(companySecretDeploymentAssertions)
      .set({ status: "consumed", consumedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(companySecretDeploymentAssertions.id, id),
        eq(companySecretDeploymentAssertions.status, "pending"),
        gt(companySecretDeploymentAssertions.expiresAt, new Date()),
      ))
      .returning();
    return row ?? null;
  }

  async function hasPendingFor(secretId: string, valueFingerprintSha256: string) {
    const rows = await db
      .select({ id: companySecretDeploymentAssertions.id })
      .from(companySecretDeploymentAssertions)
      .where(and(
        eq(companySecretDeploymentAssertions.secretId, secretId),
        eq(companySecretDeploymentAssertions.valueFingerprintSha256, valueFingerprintSha256),
        eq(companySecretDeploymentAssertions.status, "pending"),
        gt(companySecretDeploymentAssertions.expiresAt, new Date()),
      ))
      .limit(1);
    return rows.length > 0;
  }

  async function assertRegistrationPreconditions(input: {
    secret: { id: string; companyId: string; status: string; latestVersion: number };
    expectedLatestVersion: number;
    valueFingerprintSha256: string;
    previousValueFingerprintSha256: string;
  }) {
    if (input.secret.status !== "active") {
      throw unprocessable("Cannot register a deployment assertion for a non-active secret");
    }
    if (input.expectedLatestVersion !== input.secret.latestVersion) {
      throw conflict("expectedLatestVersion does not match the secret's current version");
    }
    const liveFingerprint = await currentVersionFingerprint(input.secret.id, input.secret.latestVersion);
    if (!liveFingerprint) {
      throw conflict("The secret has no readable current version to compare against");
    }
    if (liveFingerprint !== input.previousValueFingerprintSha256) {
      throw conflict("previousValueFingerprintSha256 does not match the value currently deployed");
    }
    if (liveFingerprint === input.valueFingerprintSha256) {
      throw conflict("The asserted value already matches the value currently deployed");
    }
    return liveFingerprint;
  }

  async function loadGuarded(id: string, secret: { id: string; companyId: string }) {
    const assertion = await get(id);
    if (!assertion || assertion.secretId !== secret.id || assertion.companyId !== secret.companyId) {
      throw forbidden("deploymentAssertionId does not apply to this secret");
    }
    if (assertion.status === "consumed") {
      throw conflict("Deployment assertion was already consumed");
    }
    if (assertion.status === "expired") {
      throw forbidden("Deployment assertion expired before it was consumed");
    }
    if (assertion.status !== "pending") {
      throw forbidden("Deployment assertion is not pending");
    }
    if (assertion.expiresAt.getTime() <= Date.now()) {
      await expireIfDue(assertion.id);
      throw forbidden("Deployment assertion expired before it was consumed");
    }
    return assertion;
  }

  return {
    get,
    register,
    consume,
    hasPendingFor,
    assertRegistrationPreconditions,
    loadGuarded,
    currentVersionFingerprint,
  };
}
