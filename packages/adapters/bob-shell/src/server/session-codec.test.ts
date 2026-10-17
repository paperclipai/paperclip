/**
 * Tests for sessionCodec.
 */

import { describe, it, expect } from "vitest";
import { sessionCodec } from "./index.js";

describe("sessionCodec", () => {
  it("round-trips taskId and cwd", () => {
    const params = { taskId: "abc-123", cwd: "/home/user/project" };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).not.toBeNull();
    const deserialized = sessionCodec.deserialize(serialized!);
    expect(deserialized?.taskId).toBe("abc-123");
    expect(deserialized?.cwd).toBe("/home/user/project");
  });

  it("returns null for missing taskId", () => {
    expect(sessionCodec.serialize({ cwd: "/some/path" })).toBeNull();
    expect(sessionCodec.deserialize({ cwd: "/some/path" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
  });

  it("getDisplayId returns taskId", () => {
    expect(
      sessionCodec.getDisplayId!({ taskId: "my-task-id", cwd: "/x" }),
    ).toBe("my-task-id");
    expect(sessionCodec.getDisplayId!(null)).toBeNull();
  });

  it("accepts legacy task_id snake_case key", () => {
    const result = sessionCodec.deserialize({ task_id: "legacy-123" });
    expect(result?.taskId).toBe("legacy-123");
  });
});
