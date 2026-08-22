import { describe, expect, it } from "vitest";
import { shouldForceFreshSessionForWakeReason } from "../services/heartbeat.js";

describe("configured fresh-session wake reasons", () => {
  it("matches a configured heartbeat wake reason", () => {
    expect(
      shouldForceFreshSessionForWakeReason(
        {
          heartbeat: {
            freshSessionWakeReasons: ["issue_continuation_needed", "issue_blockers_resolved"],
          },
        },
        "issue_continuation_needed",
      ),
    ).toBe(true);
  });

  it("does not reset sessions for unconfigured wake reasons", () => {
    expect(
      shouldForceFreshSessionForWakeReason(
        { heartbeat: { freshSessionWakeReasons: ["issue_continuation_needed"] } },
        "issue_commented",
      ),
    ).toBe(false);
  });

  it("ignores missing, malformed, and empty values", () => {
    expect(shouldForceFreshSessionForWakeReason({}, "issue_continuation_needed")).toBe(false);
    expect(
      shouldForceFreshSessionForWakeReason(
        { heartbeat: { freshSessionWakeReasons: "issue_continuation_needed" } },
        "issue_continuation_needed",
      ),
    ).toBe(false);
    expect(
      shouldForceFreshSessionForWakeReason(
        { heartbeat: { freshSessionWakeReasons: [null, "", 42] } },
        "issue_continuation_needed",
      ),
    ).toBe(false);
    expect(
      shouldForceFreshSessionForWakeReason(
        { heartbeat: { freshSessionWakeReasons: ["issue_continuation_needed"] } },
        null,
      ),
    ).toBe(false);
  });
});
