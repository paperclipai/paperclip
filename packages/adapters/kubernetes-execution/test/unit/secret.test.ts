import { describe, it, expect } from "vitest";
import { buildEphemeralSecret } from "../../src/orchestrator/secret.js";

describe("buildEphemeralSecret", () => {
  it("base64-encodes all data values", () => {
    const s = buildEphemeralSecret({
      namespace: "paperclip-acme",
      agentSlug: "a-acme", runUlid: "01H...", companyId: "c-1", companySlug: "acme",
      runId: "r-1",
      data: { BOOTSTRAP_TOKEN: "bst_abc", ANTHROPIC_API_KEY: "sk-test123456" },
      ownerJob: { name: "agent-a-acme-run-01H", uid: "fake-uid" },
    });
    expect(s.type).toBe("Opaque");
    expect(s.data?.["BOOTSTRAP_TOKEN"]).toBe(Buffer.from("bst_abc").toString("base64"));
    expect(s.data?.["ANTHROPIC_API_KEY"]).toBe(Buffer.from("sk-test123456").toString("base64"));
  });

  it("attaches an OwnerReference to the Job", () => {
    const s = buildEphemeralSecret({
      namespace: "paperclip-acme", agentSlug: "a", runUlid: "01H",
      companyId: "c-1", companySlug: "acme", runId: "r-1",
      data: {}, ownerJob: { name: "agent-a-run-01H", uid: "abc-uid" },
    });
    const owner = s.metadata?.ownerReferences?.[0];
    expect(owner?.kind).toBe("Job");
    expect(owner?.uid).toBe("abc-uid");
    expect(owner?.controller).toBe(true);
    expect(owner?.blockOwnerDeletion).toBe(true);
  });

  it("includes paperclip.ai/run-id label", () => {
    const s = buildEphemeralSecret({
      namespace: "paperclip-acme", agentSlug: "a", runUlid: "01H",
      companyId: "c-1", companySlug: "acme", runId: "run-42",
      data: {}, ownerJob: { name: "x", uid: "y" },
    });
    expect(s.metadata?.labels?.["paperclip.ai/run-id"]).toBe("run-42");
  });
});
