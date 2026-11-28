import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeartbeatRunStatus } from "./HeartbeatRunStatus";

function render(livenessState: Parameters<typeof HeartbeatRunStatus>[0]["run"]["livenessState"]) {
  return renderToStaticMarkup(<HeartbeatRunStatus run={{ status: "succeeded", livenessState }} />);
}

describe("HeartbeatRunStatus", () => {
  it.each(["empty_response", "plan_only", "needs_followup"] as const)(
    "does not present a clean %s run as delivery success",
    (state) => {
      expect(render(state)).toContain("Incomplete");
      expect(render(state)).toContain("Run succeeded");
    },
  );

  it.each([
    ["advanced", "Progress recorded"],
    ["blocked", "Blocked"],
    ["completed", "Task closed"],
  ] as const)("preserves the recorded %s outcome", (state, label) => {
    expect(render(state)).toContain(label);
    expect(render(state)).toContain("Run succeeded");
  });

  it("does not infer a task outcome when none was recorded", () => {
    expect(render(null)).toContain("Run succeeded");
    expect(render(null)).not.toContain("Incomplete");
  });
});
