import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_HARNESS_EVENT_ENVELOPE_SCHEMA_VERSION,
  agentHarnessEventEnvelopeSchema,
  createAgentHarnessEventEnvelopeSchema,
  createAgentHarnessEventSchemaRegistry,
} from "./agent-harness-events.js";

function buildBaseEvent() {
  return {
    specVersion: AGENT_HARNESS_EVENT_ENVELOPE_SCHEMA_VERSION,
    schemaVersion: 1,
    cloudEventsSpecVersion: "1.0",
    id: "evt-1",
    source: "eaos://company/company-1/project/project-1/kernel",
    type: "eaos.approval.requested",
    time: "2026-05-15T10:00:00.000Z",
    recordedAt: "2026-05-15T10:00:01.000Z",
    dataSchema: "eaos://schemas/approval/requested/v1",
    scope: {
      companyId: "company-1",
    },
    actor: {
      kind: "agent",
      id: "agent-1",
      name: "EAOS Executor",
    },
    approvalPosture: "pending",
    redactionClass: "public",
    riskClass: "low",
    idempotencyKey: "approval:apr-1",
    data: { destination_ref: "secret://value" },
  };
}

describe("agent harness event envelope schema", () => {
  it("fails when required envelope fields are missing", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects legacy or unknown envelope fields", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      specversion: "1.0",
    });
    expect(result.success).toBe(false);
  });

  it("requires data when other required fields are present", () => {
    const withoutData = { ...buildBaseEvent() } as Record<string, unknown>;
    delete withoutData.data;
    const result = agentHarnessEventEnvelopeSchema.safeParse(withoutData);
    expect(result.success).toBe(false);
  });

  it("requires actor", () => {
    const withoutActor = { ...buildBaseEvent() } as Record<string, unknown>;
    delete withoutActor.actor;
    const result = agentHarnessEventEnvelopeSchema.safeParse(withoutActor);
    expect(result.success).toBe(false);
  });

  it("accepts LET-208 actor kind values", () => {
    for (const kind of ["agent", "user", "system", "external"] as const) {
      const result = agentHarnessEventEnvelopeSchema.safeParse({
        ...buildBaseEvent(),
        actor: { kind, id: `${kind}-1` },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects non-LET-208 actor kind values", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      actor: {
        kind: "human",
        id: "user-1",
      },
    });
    expect(result.success).toBe(false);
  });

  it("requires scope.companyId", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      scope: {},
    });
    expect(result.success).toBe(false);
  });

  it("allows additional scope keys while requiring companyId", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      scope: { companyId: "company-1", projectId: "project-1", runId: "run-1" },
    });
    expect(result.success).toBe(true);
  });

  it("requires source to match company path boundary", () => {
    const wrongCompany = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      source: "eaos://company/company-2/project/project-1/kernel",
    });
    expect(wrongCompany.success).toBe(false);

    const prefixCollision1 = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      source: "eaos://company/company-10/project/project-1/kernel",
    });
    expect(prefixCollision1.success).toBe(false);

    const prefixCollision2 = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      source: "eaos://company/company-1evil/project/project-1/kernel",
    });
    expect(prefixCollision2.success).toBe(false);
  });

  it("requires recordedAt to be greater than or equal to time", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      recordedAt: "2026-05-15T09:59:59.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("requires LET-208 dataSchema URI shape", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      dataSchema: "eaos.events/1/generic",
    });
    expect(result.success).toBe(false);
  });

  it("requires schemaVersion to match dataSchema version", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      schemaVersion: 2,
      dataSchema: "eaos://schemas/approval/requested/v1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts matching schemaVersion and dataSchema version", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      schemaVersion: 3,
      dataSchema: "eaos://schemas/approval/requested/v3",
    });
    expect(result.success).toBe(true);
  });

  it("rejects raw secret values even for public redaction class", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      redactionClass: "public",
      data: {
        password: "super-secret-password",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects raw private URL values even on safe-reference suffix keys", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      data: {
        destination_ref: "https://private.example.com/hook",
      },
    });
    expect(result.success).toBe(false);
  });

  it("preserves approvalPosture, redactionClass, and riskClass values", () => {
    const parsed = agentHarnessEventEnvelopeSchema.parse({
      ...buildBaseEvent(),
      approvalPosture: "approved",
      redactionClass: "confidential",
      riskClass: "critical",
    });
    expect(parsed.approvalPosture).toBe("approved");
    expect(parsed.redactionClass).toBe("confidential");
    expect(parsed.riskClass).toBe("critical");
  });

  it("does not reject ordinary storage URLs when field names are non-sensitive", () => {
    const result = agentHarnessEventEnvelopeSchema.safeParse({
      ...buildBaseEvent(),
      redactionClass: "secret_redacted",
      data: {
        artifactLocation: "s3://bucket/path/output.json",
      },
    });
    expect(result.success).toBe(true);
  });

  it("supports registry payload hooks per dataSchema", () => {
    const registry = createAgentHarnessEventSchemaRegistry([
      {
        dataSchema: "eaos://schemas/approval/requested/v1",
        payloadSchema: z.object({ runId: z.string().min(1) }),
      },
    ]);
    const schema = createAgentHarnessEventEnvelopeSchema(registry);

    const invalid = schema.safeParse({
      ...buildBaseEvent(),
      data: {},
    });
    expect(invalid.success).toBe(false);

    const valid = schema.safeParse({
      ...buildBaseEvent(),
      data: { runId: "run-1" },
    });
    expect(valid.success).toBe(true);
  });

  it("enforces idempotency key for retryable schema families", () => {
    const registry = createAgentHarnessEventSchemaRegistry([
      {
        dataSchema: "eaos://schemas/approval/requested/v1",
        requiresIdempotencyKey: true,
      },
    ]);
    const schema = createAgentHarnessEventEnvelopeSchema(registry);

    const missing = schema.safeParse({
      ...buildBaseEvent(),
      idempotencyKey: null,
    });
    expect(missing.success).toBe(false);

    const present = schema.safeParse({
      ...buildBaseEvent(),
      idempotencyKey: "approval:apr-1",
    });
    expect(present.success).toBe(true);
  });

  it("rejects unregistered dataSchema when a registry is provided", () => {
    const registry = createAgentHarnessEventSchemaRegistry([]);
    const schema = createAgentHarnessEventEnvelopeSchema(registry);

    const result = schema.safeParse(buildBaseEvent());
    expect(result.success).toBe(false);
  });
});
