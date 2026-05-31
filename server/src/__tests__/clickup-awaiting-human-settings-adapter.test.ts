import { describe, expect, it } from "vitest";
import {
  normalizeClickUpAttachmentTaskId,
  normalizeClickUpAwaitingHumanProviderConfig,
} from "../services/clickup-awaiting-human-settings-adapter.js";

describe("clickup awaiting human settings adapter", () => {
  it("extracts task id from ClickUp task urls", () => {
    expect(normalizeClickUpAttachmentTaskId("86d35fwx8")).toBe("86d35fwx8");
    expect(
      normalizeClickUpAttachmentTaskId("https://app.clickup.com/t/90161423646/86d35fwx8"),
    ).toBe("86d35fwx8");
  });

  it("normalizes attachment task id when saving provider config", () => {
    expect(
      normalizeClickUpAwaitingHumanProviderConfig({
        workspaceId: "90161423646",
        channelId: "channel-1",
        attachmentTaskId: "https://app.clickup.com/t/90161423646/86d35fwx8",
      }),
    ).toEqual({
      workspaceId: "90161423646",
      channelId: "channel-1",
      attachmentTaskId: "86d35fwx8",
    });
  });
});
