import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultProvider, UndiciVaultGateway } from "../secrets/vault-provider.js";

const RUN = process.env.PAPERCLIP_TEST_VAULT === "1";
const ADDR = process.env.PAPERCLIP_TEST_VAULT_ADDR ?? "http://127.0.0.1:8200";
const TOKEN = process.env.PAPERCLIP_TEST_VAULT_TOKEN ?? "root";

describe.skipIf(!RUN)("vault provider — integration (PAPERCLIP_TEST_VAULT=1)", () => {
  beforeAll(() => {
    process.env.VAULT_TOKEN = TOKEN;
  });
  afterAll(() => {
    delete process.env.VAULT_TOKEN;
  });

  function makeProvider() {
    const config = {
      address: ADDR,
      namespace: null,
      kvMount: "secret",
      kvPathPrefix: `paperclip-test-${process.pid}`,
      auth: { method: "token" as const, role: null, saTokenPath: "/dev/null" },
      versionRetention: 5,
    };
    const gateway = new UndiciVaultGateway({
      address: ADDR,
      namespace: null,
      getToken: async () => TOKEN,
    });
    return createVaultProvider({ config, gateway });
  }

  it("create + rotate + resolve(latest) + resolve(version) end-to-end", async () => {
    const provider = makeProvider();
    const ctx = {
      companyId: "co-int",
      deploymentId: "test",
      secretId: "sec-int",
      secretKey: "INT_KEY",
      secretName: "INT_KEY",
      version: 1,
    };
    const v1 = await provider.createSecret({ value: "value-v1", context: ctx });
    const v2 = await provider.createVersion({
      value: "value-v2",
      context: ctx,
      externalRef: v1.externalRef,
    });
    expect(v2.providerVersionRef).toBe("2");

    const latest = await provider.resolveVersion({
      material: v2.material,
      externalRef: v2.externalRef,
      context: {
        companyId: ctx.companyId,
        secretId: ctx.secretId,
        secretKey: ctx.secretKey,
        version: 2,
      },
    });
    expect(latest).toBe("value-v2");

    const pinned = await provider.resolveVersion({
      material: v1.material,
      externalRef: v1.externalRef,
      providerVersionRef: "1",
      context: {
        companyId: ctx.companyId,
        secretId: ctx.secretId,
        secretKey: ctx.secretKey,
        version: 1,
      },
    });
    expect(pinned).toBe("value-v1");

    await provider.deleteOrArchive({
      material: v2.material,
      externalRef: v2.externalRef,
      context: ctx,
      mode: "delete",
    });
  });

  it("retention enforces max_versions = 5", async () => {
    const provider = makeProvider();
    const ctx = {
      companyId: "co-int",
      deploymentId: "test",
      secretId: "sec-ret",
      secretKey: "RET_KEY",
      secretName: "RET_KEY",
      version: 1,
    };
    const v1 = await provider.createSecret({ value: "v1", context: ctx });
    let ref = v1.externalRef;
    for (let i = 2; i <= 8; i += 1) {
      const r = await provider.createVersion({
        value: `v${i}`,
        context: { ...ctx, version: i - 1 },
        externalRef: ref,
      });
      ref = r.externalRef;
    }
    await expect(
      provider.resolveVersion({
        material: v1.material,
        externalRef: ref,
        providerVersionRef: "1",
        context: {
          companyId: ctx.companyId,
          secretId: ctx.secretId,
          secretKey: ctx.secretKey,
          version: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await provider.deleteOrArchive({
      material: v1.material,
      externalRef: ref,
      context: ctx,
      mode: "delete",
    });
  });

  it("health check returns ok against a configured dev bao", async () => {
    const provider = makeProvider();
    const h = await provider.healthCheck();
    expect(["ok", "warn"]).toContain(h.status);
    expect(h.details).toBeTruthy();
  });
});
