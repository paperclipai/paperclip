import { describe, expect, it } from "vitest";
import { runnerApiProviderResponse } from "./runner-api-provider-response.js";

const key = "synthetic-webhook-key-for-provider-projection";
const trigger = { id: "trigger-a", routineId: "routine-a", kind: "webhook", signingMode: "bearer", webhookUrl: "https://example.test/hooks/public-a" };
const secretMaterial = { webhookUrl: trigger.webhookUrl, webhookSecret: key };
const operations = [
  "POST /api/routines/{id}/triggers",
  "POST /api/routine-triggers/{id}/rotate-secret",
  "POST /api/routines/{id}/revisions/{revisionId}/restore",
];

describe("routine webhook provider projection", () => {
  it.each(operations)("keeps metadata and withholds the credential for %s, fresh and decrypted replay", operationId => {
    const restore = operationId.endsWith("/restore");
    const data = restore
      ? { routine: { id: "routine-a", title: "Weekly report" }, revision: { id: "revision-a" }, secretMaterials: [{ ...secretMaterial, triggerId: "trigger-a" }] }
      : { trigger, revision: { id: "revision-a" }, secretMaterial };
    const raw = { ok: true, status: restore ? 200 : 201, operationId, data };
    const saved = JSON.stringify(raw);
    const projected = runnerApiProviderResponse(operationId, raw, "TEAM");
    expect(JSON.stringify(projected)).not.toContain(key);
    expect(projected).toMatchObject({ ok: true, status: raw.status,
      data: restore ? { routine: data.routine, revision: data.revision } : { trigger, revision: data.revision },
      secureSetup: { path: "/TEAM/routines/routine-a/triggers" },
    });
    expect((projected as any).data).not.toHaveProperty("secretMaterial");
    expect((projected as any).data).not.toHaveProperty("secretMaterials");
    expect(runnerApiProviderResponse(operationId, JSON.parse(saved), "TEAM")).toEqual(projected);
    expect(JSON.stringify(raw)).toBe(saved);
  });

  it("does not return malformed credential material inline", () => {
    const raw = { ok: true, data: { routine: { id: "routine-a" }, secretMaterials: key } };
    expect(JSON.stringify(runnerApiProviderResponse(operations[2], raw, "TEAM"))).not.toContain(key);
  });

  it("preserves scoped secret resolution and other sensitive API contracts", () => {
    const raw = { ok: true, data: { key: "TEST_TOKEN", value: key } };
    expect(runnerApiProviderResponse("POST /api/agents/me/secrets/{key}/value", raw, "TEAM")).toBe(raw);
    expect(runnerApiProviderResponse("POST /api/chat-endpoints/{id}/setup-secret", raw, "TEAM")).toBe(raw);
  });

  it("keeps schedule metadata and route denials unchanged", () => {
    const schedule = { ok: true, data: { trigger: { id: "schedule-a", kind: "schedule" }, secretMaterial: null } };
    expect(runnerApiProviderResponse(operations[0], schedule, "TEAM")).toEqual(schedule);
    const denial = { ok: false, status: 403, data: { error: "Forbidden" } };
    expect(runnerApiProviderResponse(operations[0], denial, "TEAM")).toEqual(denial);
  });

  it("withholds unstructured targeted responses without leaking a raw preview", () => {
    const raw = { ok: false, status: 500, error: "invalid_json_response", data: `broken ${key}`, outcome: "unknown" };
    const projected = runnerApiProviderResponse(operations[0], raw, "TEAM");
    expect(JSON.stringify(projected)).not.toContain(key);
    expect(projected).toMatchObject({ ok: false, status: 500, outcome: "unknown" });
  });
});
