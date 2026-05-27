import { describe, expect, it } from "vitest";
import { patchCompanyAwaitingHumanSettingsSchema } from "./awaiting-human-settings.js";

describe("patchCompanyAwaitingHumanSettingsSchema", () => {
  it("rejects providerConfig when provider is explicitly null", () => {
    const parsed = patchCompanyAwaitingHumanSettingsSchema.safeParse({
      provider: null,
      providerConfig: {
        workspaceId: "workspace-123",
        channelId: "channel-123",
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("Expected providerConfig to be rejected when provider is null");
    }
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["providerConfig"]),
    );
  });
});
