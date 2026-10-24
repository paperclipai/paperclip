import { describe, expect, it } from "vitest";
import { adapterCuratesModelOrder } from "./model-utils";

describe("adapterCuratesModelOrder", () => {
  it("keeps the advertised order for built-in adapters with a hand-ordered list", () => {
    for (const adapterType of ["claude_local", "codex_local", "paperclip_runner", "gemini_local", "opencode_local", "agy_local"]) {
      expect(adapterCuratesModelOrder(adapterType)).toBe(true);
    }
  });

  it("leaves discovered and third-party lists to the alphabetical fallback", () => {
    // Cursor's list comes from `agent models`, whose order can change between refreshes.
    expect(adapterCuratesModelOrder("cursor")).toBe(false);
    // An externally installed adapter is not known to order its list deliberately.
    expect(adapterCuratesModelOrder("acme_plugin_adapter")).toBe(false);
  });
});
