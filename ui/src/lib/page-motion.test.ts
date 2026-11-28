import { describe, expect, it } from "vitest";
import { pageMotionKey } from "./page-motion";

describe("pageMotionKey", () => {
  it("changes between sections and between a list and its detail page", () => {
    expect(pageMotionKey(["issues"])).not.toBe(pageMotionKey(["agents"]));
    expect(pageMotionKey(["issues"])).not.toBe(pageMotionKey(["issues", "RAY-1"]));
    expect(pageMotionKey(["issues", "RAY-1"])).not.toBe(pageMotionKey(["issues", "RAY-2"]));
  });

  it("stays the same across tabs of one page", () => {
    expect(pageMotionKey(["agents", "giuseppe", "runs"])).toBe(pageMotionKey(["agents", "giuseppe", "skills"]));
    expect(pageMotionKey(["inbox", "mine"])).toBe(pageMotionKey(["inbox", "all"]));
    expect(pageMotionKey(["approvals", "pending"])).toBe(pageMotionKey(["approvals"]));
    expect(pageMotionKey(["activity", "runs"])).toBe(pageMotionKey(["activity", "costs"]));
  });

  it("keeps a chat still when switching conversations", () => {
    expect(pageMotionKey(["chats", "giuseppe"])).toBe(pageMotionKey(["chats", "other"]));
  });

  it("ignores letter case", () => {
    expect(pageMotionKey(["Inbox", "Mine"])).toBe(pageMotionKey(["inbox", "all"]));
  });
});
