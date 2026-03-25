import { describe, expect, it } from "vitest";
import { shouldSelfWake } from "../services/heartbeat.js";

describe("shouldSelfWake", () => {
  it("returns true when outcome is succeeded", () => {
    expect(shouldSelfWake("succeeded", undefined)).toBe(true);
  });

  it("returns true when outcome is failed with task-specific error", () => {
    expect(shouldSelfWake("failed", "some_task_error")).toBe(true);
  });

  it("returns true when outcome is failed with no errorCode", () => {
    expect(shouldSelfWake("failed", undefined)).toBe(true);
  });

  it("returns true when outcome is failed with null errorCode", () => {
    expect(shouldSelfWake("failed", null)).toBe(true);
  });

  it("returns false when outcome is failed with auth_failed", () => {
    expect(shouldSelfWake("failed", "auth_failed")).toBe(false);
  });

  it("returns false when outcome is failed with claude_auth_required", () => {
    expect(shouldSelfWake("failed", "claude_auth_required")).toBe(false);
  });

  it("returns false when outcome is failed with adapter_failed", () => {
    expect(shouldSelfWake("failed", "adapter_failed")).toBe(false);
  });

  it("returns false when outcome is failed with timeout", () => {
    expect(shouldSelfWake("failed", "timeout")).toBe(false);
  });

  it("returns false when outcome is timed_out", () => {
    expect(shouldSelfWake("timed_out", undefined)).toBe(false);
  });

  it("returns false when outcome is cancelled", () => {
    expect(shouldSelfWake("cancelled", undefined)).toBe(false);
  });

  it("returns false when outcome is timed_out with timeout errorCode", () => {
    expect(shouldSelfWake("timed_out", "timeout")).toBe(false);
  });

  it("returns false when outcome is cancelled with cancelled errorCode", () => {
    expect(shouldSelfWake("cancelled", "cancelled")).toBe(false);
  });
});
