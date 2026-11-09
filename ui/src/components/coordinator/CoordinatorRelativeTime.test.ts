import { describe, expect, it } from "vitest";
import { coordinatorRelativeLabel } from "./CoordinatorRelativeTime";
const now = Date.parse("2026-10-26T12:00:00Z");
describe("Coordinator message time", () => {
  it("uses the durable timestamp and handles clock skew without future ages", () => {
    expect(coordinatorRelativeLabel("2026-10-26T11:58:00Z", now)).toBe("2m ago");
    expect(coordinatorRelativeLabel("2026-10-26T10:00:00Z", now)).toBe("2h ago");
    expect(coordinatorRelativeLabel("2026-10-25T12:00:00Z", now)).toBe("1d ago");
    expect(coordinatorRelativeLabel("2026-10-26T12:01:00Z", now)).toBe("Just now");
  });
  it("does not invent a time for an invalid timestamp", () => expect(coordinatorRelativeLabel("invalid", now)).toBeNull());
});
