import { describe, expect, it } from "vitest";
import { runtimeActivity } from "./plugin-task-panels.js";

describe("structured runtime activity", () => {
  it("counts Unicode code points and matches the schema's control-character rules", () => {
    for (const activityKey of ["视".repeat(60), "😀".repeat(160), "view-0", "\u0085"]) {
      const panel = { namespace: "example.runtime", activityKey };
      expect(runtimeActivity(panel)).toEqual(panel);
    }
    for (const activityKey of ["😀".repeat(161), "\u001f", "\u007f"]) {
      expect(runtimeActivity({ namespace: "example.runtime", activityKey })).toBeNull();
    }
  });
  it("accepts only bounded panel identifiers without caller run identity", () => {
    const panel = { namespace: "example.runtime", activityKey: "screen" };
    expect(runtimeActivity(panel)).toEqual(panel);
    for (const payload of [null, { output: "[paperclip-task-panel:example.runtime:screen]" },
      { ...panel, runId: "caller-run" }, { ...panel, activityKey: "" }, { ...panel, activityKey: "x".repeat(161) },
      { ...panel, namespace: "invalid\nkey" }]) expect(runtimeActivity(payload)).toBeNull();
  });
});
