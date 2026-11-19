import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { prepareOnlineEphemeralEnrollment, readOnlineEphemeralEnrollmentEligibility } from "./ephemeral-enrollment.js";

const owners = vi.hoisted(() => ({ eligibility: vi.fn(), key: vi.fn(), audit: vi.fn() }));
vi.mock("./ephemeral-server-contract.js", async original => ({
  ...await original<typeof import("./ephemeral-server-contract.js")>(), readEphemeralServerDataEligibility: owners.eligibility,
}));
vi.mock("./decision-signing.js", () => ({ resolveDecisionSigningSecret: owners.key }));
vi.mock("./activity-log.js", () => ({ persistActivity: owners.audit, publishActivity: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig: () => ({ databaseUrl: "postgres://fixture:fixture@db.test/database", storageProvider: "s3" }) }));

let localPackages: Array<{ id: string }> = [];
const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => localPackages }) }) }) } as unknown as Db;
const attempt = "12345678-1234-4234-8234-123456789abc";
const key = "fixture-decision-signing-key-0123456789";
const control = { requestId: "fixture-signed-request", exp: 0 };
beforeEach(() => {
  vi.resetAllMocks();
  localPackages = [];
  control.exp = Math.floor(Date.now() / 1000) + 60;
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
  owners.audit.mockResolvedValue({ publication: {} });
});
afterEach(() => vi.unstubAllEnvs());

it("exports the original key only after owner eligibility, config validation and a secret-free audit", async () => {
  const result = await prepareOnlineEphemeralEnrollment(db, attempt, control);
  expect(result).toMatchObject({ attemptId: attempt, stackId: "stack-fixture", commit: "a".repeat(40),
    deploymentId: "11111111-1111-4111-8111-111111111111", ephemeralServer: false, enrollmentReady: false,
    decisionSigningSecret: key });
  expect(result.decisionKeyDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(owners.key).toHaveBeenCalledWith({ allowCreate: false });
  expect(owners.eligibility).toHaveBeenCalledWith(db, { purpose: "startup" });
  expect(owners.audit).toHaveBeenCalledOnce();
  expect(JSON.stringify(owners.audit.mock.calls)).not.toContain(key);
  expect(process.env.PAPERCLIP_EPHEMERAL_SERVER).toBe("false");
});

it("does not read or export the key while a local obligation remains", async () => {
  owners.eligibility.mockResolvedValue({ eligible: false, blockers: ["workspaces_require_migration"] });
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 409,
    details: { blockers: ["workspaces_require_migration"] } });
  expect(owners.key).not.toHaveBeenCalled(); expect(owners.audit).not.toHaveBeenCalled();
});

it("refuses an invalid replacement configuration without publishing or auditing a key", async () => {
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "postgres://fixture:fixture@other.test/database");
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 409,
    details: { blockers: ["volume_free_database_listener_required"] } });
  expect(owners.audit).not.toHaveBeenCalled();
});

it.each([
  ["PAPERCLIP_DURABLE_AGENT_FILES", "volume_free_storage_flags_required"],
  ["PAPERCLIP_SHARED_UI_ASSETS", "volume_free_storage_flags_required"],
  ["PAPERCLIP_SECRETS_MASTER_KEY", "volume_free_master_key_required"],
])("names a missing %s as a blocker in preparation and in the eligibility read", async (setting, blocker) => {
  vi.stubEnv(setting, "");
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 409, details: { blockers: [blocker] } });
  expect(owners.audit).not.toHaveBeenCalled();
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toEqual({ eligible: false, blockers: [blocker], ephemeralServer: false });
});

it("names a missing original decision key without generating one", async () => {
  owners.key.mockImplementation(() => { throw new Error("decision signing key is missing"); });
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 409,
    details: { blockers: ["volume_free_decision_key_required"] } });
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toMatchObject({ eligible: false, blockers: ["volume_free_decision_key_required"] });
  expect(owners.key).toHaveBeenCalledWith({ allowCreate: false });
});

it("reports data and configuration blockers together and stays eligible only when both are clear", async () => {
  owners.eligibility.mockResolvedValue({ eligible: false, blockers: ["agent_files_require_migration"] });
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "");
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toEqual({ eligible: false,
    blockers: ["agent_files_require_migration", "volume_free_storage_flags_required"], ephemeralServer: false });
  owners.eligibility.mockResolvedValue({ eligible: true, blockers: [] });
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toEqual({ eligible: true, blockers: [], ephemeralServer: false });
});

it("fails closed if key preservation auditing fails", async () => {
  owners.audit.mockRejectedValue(new Error("fixture_audit_failed"));
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toThrow("fixture_audit_failed");
});

it("identifies the armed deployment without granting detachment authority", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
  expect(await prepareOnlineEphemeralEnrollment(db, attempt, control)).toMatchObject({ ephemeralServer: true, enrollmentReady: false });
});

it("refuses an unknown deployment before inspecting data or keys", async () => {
  vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "");
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 409 });
  expect(owners.eligibility).not.toHaveBeenCalled(); expect(owners.key).not.toHaveBeenCalled();
});

it("refuses an expired assertion after inspection without exporting", async () => {
  control.exp = Math.floor(Date.now() / 1000) - 1;
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 401 });
  expect(owners.audit).not.toHaveBeenCalled();
});

it("keeps a skill package that is still on the volume as a blocker for the online move", async () => {
  localPackages = [{ id: "snapshot-local" }];
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toEqual({ eligible: false, blockers: ["skills_require_migration"], ephemeralServer: false });
  owners.key.mockClear();
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).rejects.toMatchObject({ status: 409,
    details: { blockers: ["skills_require_migration"] } });
  expect(owners.key).not.toHaveBeenCalled();
});

it("names the skill blocker once when installations and packages both still need migration", async () => {
  localPackages = [{ id: "snapshot-local" }];
  owners.eligibility.mockResolvedValue({ eligible: false, blockers: ["skills_require_migration"] });
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toMatchObject({ blockers: ["skills_require_migration"] });
});

it("accepts a volume server without a listener because Cloud supplies it to the replacement", async () => {
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "");
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toEqual({ eligible: true, blockers: [], ephemeralServer: false });
  await expect(prepareOnlineEphemeralEnrollment(db, attempt, control)).resolves.toMatchObject({ enrollmentReady: false, decisionSigningSecret: key });
});

it("still names a listener that points somewhere else", async () => {
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "postgres://fixture:fixture@other.test/database");
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toMatchObject({ eligible: false, blockers: ["volume_free_database_listener_required"] });
});

it("does not waive an unparseable runtime database because the listener is unset", async () => {
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "");
  const config = await import("../config.js");
  const original = config.loadConfig;
  vi.spyOn(config, "loadConfig").mockReturnValue({ ...original(), databaseUrl: "not a url" } as never);
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toMatchObject({ eligible: false, blockers: ["volume_free_configuration_required"] });
});

it("still names another missing setting when the listener is unset", async () => {
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", "");
  vi.stubEnv("PAPERCLIP_SHARED_UI_ASSETS", "");
  await expect(readOnlineEphemeralEnrollmentEligibility(db)).resolves.toMatchObject({ eligible: false, blockers: ["volume_free_storage_flags_required"] });
});
