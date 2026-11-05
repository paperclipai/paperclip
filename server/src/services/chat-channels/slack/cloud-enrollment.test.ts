import { HttpError } from "../../../errors.js";
import { generateKeyPairSync } from "node:crypto";
import { chatEndpoints, chatSlackRegistrations, type Db } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { PaperclipCloudConnectorError } from "../../paperclip-cloud-connector.js";
import { createSlackCloudEnrollment, stageSlackCloudEnrollmentIntent } from "./cloud-enrollment.js";
import type { InternalSetupState } from "../runtime-types.js";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

afterEach(() => vi.unstubAllEnvs());
function configureCloud() {
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "https://cloud.example.test");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "instance");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).d!);
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", generateKeyPairSync("x25519").privateKey.export({ format: "jwk" }).d!);
}
function jsonValues(value: unknown): unknown[] {
  if (typeof value === "string") { try { return [JSON.parse(value)]; } catch { return []; } }
  if (!value || typeof value !== "object") return [];
  const chunks = Reflect.get(value, "queryChunks");
  return Array.isArray(chunks) ? chunks.flatMap(jsonValues) : [];
}
function fixture() {
  configureCloud();
  const endpoint = { id: "00000000-0000-4000-8000-000000000001", companyId: "company", connectionId: "connection", publicId: "a".repeat(43),
    provider: "slack", status: "active", providerAccountId: "TTEST", setup: { runtimeGeneration: 1 } as InternalSetupState };
  const connection = { status: "active", enabled: true };
  let rejectWrite = false;
  const update = vi.fn((_table: object) => ({ set: (values: { setup: unknown }) => ({ where: () => {
    const write = () => {
      if (rejectWrite) return [];
      const priorIntent = endpoint.setup.slackCloudIntent;
      for (const value of jsonValues(values.setup)) {
        if (value && typeof value === "object" && "active" in value && "id" in value) {
          endpoint.setup.slackCloudIntent = value as NonNullable<InternalSetupState["slackCloudIntent"]>;

        }
        else if (value && typeof value === "object" && "bindingId" in value) { delete endpoint.setup.slackCloudIntent; delete endpoint.setup.slackCloudRetiredGeneration; endpoint.setup.slackCloudEvents = value as NonNullable<InternalSetupState["slackCloudEvents"]>; endpoint.setup.slackCloudInstanceId = priorIntent!.instanceId; endpoint.setup.slackCloudSubject = priorIntent!.subject; }
        else if (typeof value === "number") { delete endpoint.setup.slackCloudIntent; endpoint.setup.slackCloudRetiredGeneration = value; endpoint.setup.slackCloudInstanceId = priorIntent!.instanceId; endpoint.setup.slackCloudSubject = priorIntent!.subject; }
      }
      return [{ id: endpoint.id }];
    };
    return { then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(write()).then(resolve), returning: async () => write() };
  } }) }));
  const db = { update, select: (fields?: Record<string, unknown>) => {
    let table: object, joined = false;
    const rows = () => table === chatSlackRegistrations ? [{ appId: "ATEST" }] : joined
      ? [{ endpoint: structuredClone(endpoint), connection: structuredClone(connection) }]
      : fields?.setup ? [{ setup: structuredClone(endpoint.setup) }] : table === chatEndpoints ? [structuredClone(endpoint)] : [];
    const query = { from: (value: object) => { table = value; return query; }, innerJoin: () => { joined = true; return query; },
      where: () => query, limit: async () => rows(), then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
    return query;
  }, transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const previous = structuredClone(endpoint.setup);
    try { return await work(db); } catch (error) { endpoint.setup = previous; throw error; }
  } } as unknown as Db;
  const resolveCredentials = vi.fn(async () => ({ signingSecret: "synthetic" }));
  const connector = { slackEventsAvailable: vi.fn(async () => true), slackEventEnrollment: vi.fn(async (input: { enrollment: Record<string, unknown> }): Promise<unknown> => {
    const { active: _active, signingSecret: _secret, ...identity } = input.enrollment;
    return { version: 1, instanceId: "instance", ...identity, ...(input.enrollment.active ? { bindingId: `slack-event:${"b".repeat(64)}` } : {}) };
  }) };
  const lease = { assertOwned: vi.fn(async () => {}) } as unknown as CredentialMutationLeaseGuard;
  const run = createSlackCloudEnrollment(db, { resolveCredentials, runtimeGeneration: setup => Number(setup.runtimeGeneration), connector });
  const stage = () => db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as Db, endpoint.id, "original-authorized-user"));
  return { db, endpoint, connection, update, connector, resolveCredentials, lease, stage, run,
    rejectWrites: () => { rejectWrite = true; } };
}

it("stages nonsecret responsibility before network and clears only an exactly confirmed current intent", async () => {
  const f = fixture(); await f.stage();
  expect(f.connector.slackEventEnrollment).not.toHaveBeenCalled();
  expect(JSON.stringify(f.endpoint.setup.slackCloudIntent)).not.toContain("synthetic");
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudIntent).toBeUndefined();
  expect(f.endpoint.setup.slackCloudEvents?.runtimeGeneration).toBe(1);
  expect(f.connector.slackEventEnrollment).toHaveBeenCalledWith(expect.objectContaining({ subject: "original-authorized-user" }));
});

it.each(["paused", "archived"])("retains credential-free %s removal responsibility after local cleanup", async status => {
  const f = fixture(); f.endpoint.status = status; f.connection.enabled = false; f.endpoint.setup.runtimeGeneration = 2;
  await f.stage(); expect(f.endpoint.setup.slackCloudIntent?.active).toBe(false);
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.resolveCredentials).not.toHaveBeenCalled();
  expect(f.endpoint.setup.slackCloudRetiredGeneration).toBe(2);
  expect(f.endpoint.setup.slackCloudIntent).toBeUndefined();
});

it("outage preserves a bounded pending retry; current broker denial preserves visible attention debt", async () => {
  const f = fixture(); await f.stage();
  f.connector.slackEventsAvailable.mockRejectedValueOnce(new PaperclipCloudConnectorError("offline", "CONNECTOR_UNAVAILABLE"));
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ attempts: 1, failureCode: "broker_unavailable" });
  expect(Date.parse(f.endpoint.setup.slackCloudIntent!.nextAttemptAt!)).toBeGreaterThan(Date.now());
  f.connector.slackEventEnrollment.mockRejectedValueOnce(new PaperclipCloudConnectorError("denied", "CONNECTOR_REQUEST_FAILED", 403));
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ failureCode: "authority_required", nextAttemptAt: null });
});

it("receipt identity mismatch and failed transaction guard cannot publish a live descriptor", async () => {
  const f = fixture(); await f.stage();
  f.connector.slackEventEnrollment.mockResolvedValueOnce({ version: 1, runtimeGeneration: 999 });
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudEvents).toBeUndefined(); expect(f.endpoint.setup.slackCloudIntent).toBeDefined();
  f.rejectWrites(); await expect(f.run(f.endpoint.id, undefined, f.lease)).rejects.toThrow("changed");
  expect(f.endpoint.setup.slackCloudEvents).toBeUndefined(); expect(f.endpoint.setup.slackCloudIntent).toBeDefined();
});

it("an absent Cloud configuration creates no new intent or background retry", async () => {
  const f = fixture(); for (const key of ["BASE_URL", "INSTANCE_ID", "SIGN_PRIVATE_KEY", "SEAL_PRIVATE_KEY", "ENVIRONMENT"]) vi.stubEnv(`PAPERCLIP_CLOUD_CONNECTOR_${key}`, "");
  await f.stage(); expect(f.update).not.toHaveBeenCalled(); expect(f.endpoint.setup.slackCloudIntent).toBeUndefined();
});

it.each(["SLACK_ENROLLMENT_GENERATION_CHANGED", "SLACK_ENROLLMENT_DISABLED"])("closed broker reason %s distinguishes permanent authority from rollout retry", async reason => {
  const f = fixture(); await f.stage();
  f.connector.slackEventEnrollment.mockRejectedValueOnce(new PaperclipCloudConnectorError("rejected", "REAUTHORIZATION_REQUIRED", 409, undefined, reason));
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudEvents).toBeUndefined();
  expect(f.endpoint.setup.slackCloudIntent!.nextAttemptAt === null).toBe(reason === "SLACK_ENROLLMENT_GENERATION_CHANGED");
  expect(f.endpoint.setup.slackCloudIntent!.failureCode).toBe(reason === "SLACK_ENROLLMENT_DISABLED" ? "enrollment_disabled" : "authority_required");
});

it("losing Cloud identity retains configured retirement responsibility as attention without an empty retry", async () => {
  const f = fixture(); await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  f.endpoint.status = "archived"; f.connection.enabled = false; f.endpoint.setup.runtimeGeneration = 2;
  for (const key of ["BASE_URL", "INSTANCE_ID", "SIGN_PRIVATE_KEY", "SEAL_PRIVATE_KEY", "ENVIRONMENT"]) vi.stubEnv(`PAPERCLIP_CLOUD_CONNECTOR_${key}`, "");
  await f.stage();
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ active: false, instanceId: "instance", runtimeGeneration: 2,
    failureCode: "connector_configuration_unavailable", nextAttemptAt: null });
  expect(f.connector.slackEventEnrollment).toHaveBeenCalledOnce();
});

it.each([404, 422])("unavailable signing credential %s becomes retained attention instead of broker retry", async status => {
  const f = fixture(); await f.stage();
  f.resolveCredentials.mockRejectedValueOnce(new HttpError(status, "synthetic credential failure"));
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ failureCode: "signing_credential_unavailable", nextAttemptAt: null });
  expect(f.connector.slackEventEnrollment).not.toHaveBeenCalled();
  expect(f.endpoint.setup.slackCloudEvents).toBeUndefined();
});

it("temporary signing-credential store failure keeps the bounded retry", async () => {
  const f = fixture(); await f.stage();
  f.resolveCredentials.mockRejectedValueOnce(new Error("temporary database failure"));
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudIntent?.failureCode).toBe("broker_unavailable");
  expect(Date.parse(f.endpoint.setup.slackCloudIntent!.nextAttemptAt!)).toBeGreaterThan(Date.now());
  expect(f.connector.slackEventEnrollment).not.toHaveBeenCalled();
});

it("only positive old retirement and an explicit new generation can stage a replacement instance", async () => {
  const f = fixture(); await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  const oldDescriptor = structuredClone(f.endpoint.setup.slackCloudEvents);
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "replacement");
  f.endpoint.setup.runtimeGeneration = 2;
  await f.stage();
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ instanceId: "instance", subject: "original-authorized-user",
    failureCode: "instance_replacement_requires_retirement", nextAttemptAt: null });
  expect(f.endpoint.setup.slackCloudEvents).toEqual(oldDescriptor);
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "instance");
  f.endpoint.status = "paused"; f.connection.enabled = false; f.endpoint.setup.runtimeGeneration = 3;
  await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudRetiredGeneration).toBe(3);
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "replacement");
  f.endpoint.status = "active"; f.connection.enabled = true; f.endpoint.setup.runtimeGeneration = 4;
  await f.stage();
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ instanceId: "replacement", runtimeGeneration: 4 });
  expect(f.endpoint.setup.slackCloudInstanceId).toBe("instance");
  expect(f.endpoint.setup.slackCloudSubject).toBe("original-authorized-user");
  expect(f.endpoint.setup.slackCloudEvents).toEqual(oldDescriptor);
  f.connector.slackEventEnrollment.mockImplementationOnce(async input => {
    const { active: _active, signingSecret: _secret, ...identity } = input.enrollment;
    return { version: 1, instanceId: "replacement", ...identity, bindingId: `slack-event:${"c".repeat(64)}` };
  });
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.endpoint.setup.slackCloudInstanceId).toBe("replacement");
  expect(f.endpoint.setup.slackCloudIntent).toBeUndefined();
  expect(f.endpoint.setup.slackCloudRetiredGeneration).toBeUndefined();
  expect(f.endpoint.setup.slackCloudEvents?.runtimeGeneration).toBe(4);
});

it("a new config without an explicit actor cannot adopt even a retired old instance", async () => {
  const f = fixture(); await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  f.endpoint.status = "paused"; f.connection.enabled = false; f.endpoint.setup.runtimeGeneration = 2;
  await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "replacement");
  f.endpoint.status = "active"; f.connection.enabled = true; f.endpoint.setup.runtimeGeneration = 3;
  await stageSlackCloudEnrollmentIntent(f.db, f.endpoint.id, undefined);
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ instanceId: "instance", subject: "original-authorized-user",
    nextAttemptAt: null, failureCode: "instance_replacement_requires_retirement" });
});

it("removal after an unconfirmed replacement targets its pending instance without new credentials", async () => {
  const f = fixture(); await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  f.endpoint.status = "paused"; f.connection.enabled = false; f.endpoint.setup.runtimeGeneration = 2;
  await f.stage(); await f.run(f.endpoint.id, undefined, f.lease);
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "replacement");
  f.endpoint.status = "active"; f.connection.enabled = true; f.endpoint.setup.runtimeGeneration = 3;
  await f.stage();
  expect(f.endpoint.setup.slackCloudInstanceId).toBe("instance");
  f.endpoint.status = "archived"; f.connection.enabled = false; f.endpoint.setup.runtimeGeneration = 4;
  await f.stage();
  expect(f.endpoint.setup.slackCloudIntent).toMatchObject({ active: false, instanceId: "replacement", runtimeGeneration: 4 });
  f.resolveCredentials.mockClear();
  f.connector.slackEventEnrollment.mockImplementationOnce(async input => {
    const { active: _active, ...identity } = input.enrollment;
    return { version: 1, instanceId: "replacement", ...identity };
  });
  await f.run(f.endpoint.id, undefined, f.lease);
  expect(f.resolveCredentials).not.toHaveBeenCalled();
  expect(f.endpoint.setup.slackCloudIntent).toBeUndefined();
  expect(f.endpoint.setup.slackCloudInstanceId).toBe("replacement");
  expect(f.endpoint.setup.slackCloudRetiredGeneration).toBe(4);
});
