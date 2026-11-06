import { describe, expect, it, vi } from "vitest";
import { executePaperclipNativeSession } from "./native-session-executor.js";

describe("experimental native quota capability dispatch", () => {
  it("rejects a saved v11 input before selecting or starting a provider", async () => {
    const openSession = vi.fn();
    const input = { execution: { schema: "paperclip.native-execution-input.v11" }, backend: { openSession } } as unknown as Parameters<typeof executePaperclipNativeSession>[0];
    await expect(executePaperclipNativeSession(input)).rejects.toThrow("native_quota_failover_unavailable");
    expect(openSession).not.toHaveBeenCalled();
  });
});
