import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompanyMuseApiKey } from "@paperclipai/adapter-muse-local/server";
import { createMuseDeviceLoginPromotion, type MuseDeviceLoginPromotionDeps } from "./muse-device-login-promotion.js";

const KEY = "LLM|777777777777777|sandboxloginkey0000000000";
const authBytes = Buffer.from(JSON.stringify({ providers: { meta: { mechanism: "oauth", api_key: KEY, access_token: "dca:secret", user_email: "person@example.com" } } }));
const context = { sessionId: "session-1", companyId: "company-1", startedByUserId: "user-1", adapterType: "muse_local" as const };
const intent = { provider: "meta", method: "subscription", name: "Muse", ownership: "personal", agentIds: [], allAgents: true } as const;

function harness(row: Record<string, unknown> | null) {
  const locks: unknown[][] = [];
  const store = {
    get: vi.fn(async () => row),
    withCompanyAdapterPromotionLock: vi.fn(async (companyId: string, userId: string, adapterType: string, fn: () => Promise<unknown>) => {
      locks.push([companyId, userId, adapterType]);
      return fn();
    }),
  };
  const saveAiConnection = vi.fn(async () => {});
  const logs: string[] = [];
  const promotion = createMuseDeviceLoginPromotion({ store: store as unknown as MuseDeviceLoginPromotionDeps["store"], saveAiConnection, log: (line) => { logs.push(line); } });
  return { promotion, store, saveAiConnection, locks, logs };
}

let home: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-promotion-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe("muse_local device-login promotion", () => {
  it("saves only the bare key to the AI connection for a managed session, under the slot lock", async () => {
    const { promotion, saveAiConnection, locks } = harness({ status: "promoting", companyId: "company-1", aiConnection: intent });
    await promotion.promote(authBytes, context);
    expect(locks).toEqual([["company-1", "user-1", "muse_local"]]);
    expect(saveAiConnection).toHaveBeenCalledWith("company-1", "user-1", intent, KEY, "session-1");
    await expect(readCompanyMuseApiKey(process.env, "company-1")).resolves.toBeNull();
  });

  it("rejects an unusable managed credential without saving", async () => {
    const { promotion, saveAiConnection } = harness({ status: "promoting", companyId: "company-1", aiConnection: intent });
    await expect(promotion.promote(Buffer.from("{}"), context)).rejects.toThrow("not ready");
    expect(saveAiConnection).not.toHaveBeenCalled();
  });

  it("writes the company key for an unmanaged session that still owns the slot", async () => {
    const { promotion, saveAiConnection, logs } = harness({ status: "promoting", companyId: "company-1", aiConnection: null });
    await promotion.promote(authBytes, context);
    expect(saveAiConnection).not.toHaveBeenCalled();
    await expect(readCompanyMuseApiKey(process.env, "company-1")).resolves.toBe(KEY);
    expect(logs.join("\n")).not.toMatch(/LLM\||@|dca:/);
  });

  it("fails an unmanaged session that lost the slot and writes nothing", async () => {
    const { promotion } = harness({ status: "authenticated", companyId: "company-1", aiConnection: null });
    await expect(promotion.promote(authBytes, context)).rejects.toThrow("not_sole_owner");
    await expect(readCompanyMuseApiKey(process.env, "company-1")).resolves.toBeNull();
  });
});
