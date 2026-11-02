import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import * as identity from "./cloud-runtime-identity.js";
import { createCloudWarmStandby } from "./cloud-warm-standby.js";

const env = {
  PAPERCLIP_CLOUD_WARM_STANDBY: "1",
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "test-token",
  PAPERCLIP_CLOUD_STACK_ID: "stack-test",
  PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: "test-keys",
};
function database(rows: unknown[] = []) {
  const limit = vi.fn().mockResolvedValue(rows);
  const select = vi.fn(() => ({ from: () => ({ limit }) }));
  return { db: { select } as unknown as Db, select, limit };
}

afterEach(() => vi.restoreAllMocks());

describe("Cloud warm standby", () => {
  it.each([
    {},
    { ...env, PAPERCLIP_CLOUD_WARM_STANDBY: "0" },
    { ...env, PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: undefined },
    { ...env, PAPERCLIP_CLOUD_STACK_ID: undefined },
    { ...env, PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: undefined },
  ])("leaves ordinary or incomplete configurations active without querying", async (config) => {
    const { db, select } = database();
    expect((await createCloudWarmStandby(db, config))()).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("protects existing company data even when the marker is set", async () => {
    const { db } = database([{ id: "company-test" }]);
    expect((await createCloudWarmStandby(db, env))()).toBe(false);
  });

  it("never mistakes a failed empty-database check for standby", async () => {
    const { db, limit } = database();
    limit.mockRejectedValue(new Error("database unavailable"));
    await expect(createCloudWarmStandby(db, env)).rejects.toThrow("database unavailable");
  });

  it("checks emptiness once and exits standby monotonically on the matching committed claim", async () => {
    const getter = vi.spyOn(identity, "getCloudRuntimeIdentity").mockReturnValue(null);
    const { db, select } = database();
    const isStandby = await createCloudWarmStandby(db, env);
    for (let i = 0; i < 100; i++) expect(isStandby()).toBe(true);
    expect(select).toHaveBeenCalledOnce();
    const claimed = { stackId: "stack-other" } as identity.CloudRuntimeIdentitySnapshot;
    getter.mockReturnValue(claimed);
    expect(isStandby()).toBe(true);
    getter.mockReturnValue({ ...claimed, stackId: env.PAPERCLIP_CLOUD_STACK_ID });
    expect(isStandby()).toBe(false);
    getter.mockReturnValue(null);
    expect(isStandby()).toBe(false);
    expect(select).toHaveBeenCalledOnce();
  });

  it("starts active after a persisted identity is restored, even with no companies", async () => {
    vi.spyOn(identity, "getCloudRuntimeIdentity").mockReturnValue({ stackId: env.PAPERCLIP_CLOUD_STACK_ID } as identity.CloudRuntimeIdentitySnapshot);
    const { db, select } = database();
    expect((await createCloudWarmStandby(db, env))()).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});
