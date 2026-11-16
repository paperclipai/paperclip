import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { listKnownCompanyIds, upsertConnection } from "../src/connections.js";
import manifest from "../src/manifest.js";
import { COMPANY_ID } from "./support.js";

describe("connected companies", () => {
  it("reads company ids from account entities", async () => {
    const harness = createTestHarness({ manifest });
    expect(await listKnownCompanyIds(harness.ctx)).toEqual([]);
    await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "1001", username: "desk", displayName: "Front Desk" },
      sessionSecretId: "secret-1",
      sessionConfigPath: "plugin-secret.secret-1",
    });
    expect(await listKnownCompanyIds(harness.ctx)).toEqual([COMPANY_ID]);
  });
});
