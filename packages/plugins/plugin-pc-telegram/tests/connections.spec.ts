import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { listConnections, listKnownCompanyIds, upsertConnection } from "../src/connections.js";
import manifest from "../src/manifest.js";
import { COMPANY_ID, OTHER_COMPANY_ID, seedCompanies } from "./support.js";

describe("connected companies", () => {
  it("discovers companies through the host company list", async () => {
    const harness = createTestHarness({ manifest });
    expect(await listKnownCompanyIds(harness.ctx)).toEqual([]);
    seedCompanies(harness, COMPANY_ID, OTHER_COMPANY_ID);
    expect(await listKnownCompanyIds(harness.ctx)).toEqual([COMPANY_ID, OTHER_COMPANY_ID]);
    await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "1001", username: "desk", displayName: "Front Desk" },
      sessionSecretId: "secret-1",
      sessionConfigPath: "plugin-secret.secret-1",
    });
    const saved = await listConnections(harness.ctx, COMPANY_ID, new Set());
    const other = await listConnections(harness.ctx, OTHER_COMPANY_ID, new Set());
    expect(saved.map((connection) => connection.telegramUserId)).toEqual(["1001"]);
    expect(other).toEqual([]);
  });
});
