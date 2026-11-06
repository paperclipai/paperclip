import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { prepareOnlineEphemeralEnrollment } from "./ephemeral-enrollment.js";

const owners = vi.hoisted(() => ({ eligibility: vi.fn(), key: vi.fn(), audit: vi.fn() }));
vi.mock("./ephemeral-server-contract.js", async original => ({
  ...await original<typeof import("./ephemeral-server-contract.js")>(), readEphemeralServerDataEligibility: owners.eligibility,
}));
vi.mock("./decision-signing.js", () => ({ resolveDecisionSigningSecret: owners.key }));
vi.mock("./activity-log.js", () => ({ logActivity: owners.audit }));
vi.mock("../config.js", () => ({ loadConfig: () => ({ databaseUrl: "postgres://fixture:fixture@db.test/database", storageProvider: "s3" }) }));

const db = {} as Db;
const attempt = "12345678-1234-4234-8234-123456789abc";
const key = "fixture-decision-signing-key-0123456789";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-managed-instance");
  vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "stack-fixture");
  vi.stubEnv("PAPERCLIP_BUILD_COMMIT", "a".repeat(40));
  vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "11111111-1111-4111-8111-111111111111");
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "false");
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  vi.stubEnv("PAPERCLIP_SHARED_UI_ASSETS", "true");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "postgres://fixture:fixture@db.test/database");
  owners.eligibility.mockResolvedValue({ eligible: true, blockers: [] });
  owners.key.mockReturnValue(key);
  owners.audit.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("exports the original key only after owner eligibility, config validation and a secret-free audit", async () => {
  const result = await prepareOnlineEphemeralEnrollment(db, attempt);
  expect(result).toMatchObject({ attemptId: attempt, stackId: "stack-fixture", commit: "a".repeat(40),
    deploymentId: "11111111-1111-4111-8111-111111111111", ephemeralServer: false, enrollmentReady: false,
    decisionSigningSecret: key });
  expect(result.decisionKeyDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(owners.key).toHaveBeenCalledWith({ allowCreate: false });
  expect(owners.audit).toHaveBeenCalledOnce();
  expect(JSON.stringify(owners.audit.mock.calls)).not.toContain(key);
  expect(process.env.PAPERCLIP_EPHEMERAL_SERVER).toBe("false");
});

it("does not read or export the key while a local obligation remains", async () => {
  owners.eligibility.mockResolvedValue({ eligible: false, blockers: ["workspaces_require_migration"] });
  await expect(prepareOnlineEphemeralEnrollment(db, attempt)).rejects.toMatchObject({ status: 409,
    details: { blockers: ["workspaces_require_migration"] } });
  expect(owners.key).not.toHaveBeenCalled(); expect(owners.audit).not.toHaveBeenCalled();
});

it("refuses an invalid replacement configuration without publishing or auditing a key", async () => {
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "postgres://fixture:fixture@other.test/database");
  await expect(prepareOnlineEphemeralEnrollment(db, attempt)).rejects.toThrow("direct connection to the same database");
  expect(owners.audit).not.toHaveBeenCalled();
});

it("fails closed if key preservation auditing fails", async () => {
  owners.audit.mockRejectedValue(new Error("fixture_audit_failed"));
  await expect(prepareOnlineEphemeralEnrollment(db, attempt)).rejects.toThrow("fixture_audit_failed");
});

it("identifies the armed deployment without granting detachment authority", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
  expect(await prepareOnlineEphemeralEnrollment(db, attempt)).toMatchObject({ ephemeralServer: true, enrollmentReady: false });
});

it("refuses an unknown deployment before inspecting data or keys", async () => {
  vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "");
  await expect(prepareOnlineEphemeralEnrollment(db, attempt)).rejects.toMatchObject({ status: 409 });
  expect(owners.eligibility).not.toHaveBeenCalled(); expect(owners.key).not.toHaveBeenCalled();
});
