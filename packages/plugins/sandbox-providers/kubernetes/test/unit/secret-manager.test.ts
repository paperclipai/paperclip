import { describe, it, expect, vi } from "vitest";
import { createPerRunSecret } from "../../src/secret-manager.js";

describe("createPerRunSecret", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    secretName: "r-abcd-env",
    runId: "r-abcd",
    ownerKind: "Job",
    ownerApiVersion: "batch/v1",
    ownerName: "r-abcd",
    ownerUid: "11111111-1111-1111-1111-111111111111",
    bootstrapToken: "tok-xyz",
    adapterEnv: { ANTHROPIC_API_KEY: "sk-test" },
  };

  it("creates a Secret with the correct name and namespace", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledOnce();
    const body = created[0].body as { metadata: { name: string; namespace: string } };
    expect(body.metadata.name).toBe("r-abcd-env");
    expect(body.metadata.namespace).toBe("paperclip-acme");
  });

  it("includes BOOTSTRAP_TOKEN and adapter env keys in stringData", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { stringData: Record<string, string> };
    expect(body.stringData.BOOTSTRAP_TOKEN).toBe("tok-xyz");
    expect(body.stringData.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("sets ownerReferences to the owner resource for cascade delete", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { metadata: { ownerReferences: { uid: string; controller: boolean }[] } };
    expect(body.metadata.ownerReferences).toHaveLength(1);
    expect(body.metadata.ownerReferences[0].uid).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.metadata.ownerReferences[0].controller).toBe(true);
  });

  it("throws if adapterEnv contains BOOTSTRAP_TOKEN", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createPerRunSecret(clients as never, {
        ...baseInput,
        adapterEnv: { BOOTSTRAP_TOKEN: "evil" },
      }),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
  });

  it("throws if ownerUid is empty", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createPerRunSecret(clients as never, { ...baseInput, ownerUid: "" }),
    ).rejects.toThrow(/ownerUid/);
  });
});
