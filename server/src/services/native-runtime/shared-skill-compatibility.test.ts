import { describe, expect, it } from "vitest";
import { sharedSkillRepositoryLayout } from "./shared-skill-compatibility.js";
describe("shared skill layout admission", () => {
  const qualified = { native: true, backend: "codex_app_server", environmentDriver: "local", homeMode: "isolated", enabled: true };
  it("uses the actual native consumer, including a Codex agent routed through a pool", () => {
    expect(sharedSkillRepositoryLayout(qualified)).toBe("shared");
  });
  it.each([{ native: false }, { backend: "acpx_runtime" }, { environmentDriver: "ssh" }, { environmentDriver: "sandbox" }, { homeMode: "preconfigured" }, { enabled: false }])("keeps an explicit portable fallback for %j", change => {
    expect(sharedSkillRepositoryLayout({ ...qualified, ...change })).toBeUndefined();
  });
  it("does not rewrite old saved layouts or downgrade already-admitted shared ones", () => {
    expect(sharedSkillRepositoryLayout({ ...qualified, persistedExecution: { schema: "paperclip.native-execution-input.v5", runtimeContext: { skills: [] } } })).toBeUndefined();
    expect(sharedSkillRepositoryLayout({ ...qualified, enabled: false, persistedExecution: { schema: "paperclip.native-execution-input.v12", runtimeContext: { skills: [{ repository: {} }] } } })).toBe("shared");
  });
});
