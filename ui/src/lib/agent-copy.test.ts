// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { copyAgentId } from "./agent-copy";
import { copyTextToClipboard } from "./clipboard";

vi.mock("./clipboard", () => ({
  copyTextToClipboard: vi.fn(),
}));

describe("copyAgentId", () => {
  it("uses the clipboard fallback helper and reports success", async () => {
    const pushToast = vi.fn();
    vi.mocked(copyTextToClipboard).mockResolvedValue(true);

    await expect(copyAgentId("agent-123", pushToast)).resolves.toBe(true);

    expect(copyTextToClipboard).toHaveBeenCalledWith("agent-123");
    expect(pushToast).toHaveBeenCalledWith({
      title: "Agent ID copied",
      tone: "success",
    });
  });

  it("reports a visible error when clipboard copy fails", async () => {
    const pushToast = vi.fn();
    vi.mocked(copyTextToClipboard).mockResolvedValue(false);

    await expect(copyAgentId("agent-123", pushToast)).resolves.toBe(false);

    expect(pushToast).toHaveBeenCalledWith({
      title: "Copy failed",
      body: "Clipboard access was blocked. Try again from a secure browser context.",
      tone: "error",
    });
  });
});
