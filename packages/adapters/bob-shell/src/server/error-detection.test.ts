import { describe, it, expect } from "vitest";
import {
  detectBobAuthRequired,
  detectBobSessionError,
  detectBobMaxTurns,
  detectBobTimeout,
  classifyBobError,
  describeBobFailure,
} from "./error-detection.js";

describe("Bob Shell Error Detection", () => {
  describe("detectBobAuthRequired", () => {
    it("should detect authentication required errors", () => {
      const result = detectBobAuthRequired({
        exitCode: 1,
        stdout: "",
        stderr: "Error: Authentication required. Please log in.",
      });

      expect(result.requiresAuth).toBe(true);
      expect(result.message).toContain("Authentication required");
    });

    it("should detect invalid API key errors", () => {
      const result = detectBobAuthRequired({
        exitCode: 1,
        stdout: "Error: Invalid API key provided",
        stderr: "",
      });

      expect(result.requiresAuth).toBe(true);
      expect(result.message).toContain("Invalid API key");
    });

    it("should detect 401 unauthorized errors", () => {
      const result = detectBobAuthRequired({
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 401 Unauthorized",
      });

      expect(result.requiresAuth).toBe(true);
    });

    it("should not detect auth errors in successful runs", () => {
      const result = detectBobAuthRequired({
        exitCode: 0,
        stdout: "Task completed successfully",
        stderr: "",
      });

      expect(result.requiresAuth).toBe(false);
      expect(result.message).toBe(null);
    });
  });

  describe("detectBobSessionError", () => {
    it("should detect session not found errors", () => {
      const result = detectBobSessionError({
        exitCode: 1,
        stdout: "",
        stderr: "Error: Session abc123 not found",
      });

      expect(result).toBe(true);
    });

    it("should detect unknown session errors", () => {
      const result = detectBobSessionError({
        exitCode: 1,
        stdout: "Error: Unknown session ID",
        stderr: "",
      });

      expect(result).toBe(true);
    });

    it("should detect failed to resume session errors", () => {
      const result = detectBobSessionError({
        exitCode: 1,
        stdout: "",
        stderr: "Failed to resume session: session expired",
      });

      expect(result).toBe(true);
    });

    it("should not detect session errors in normal output", () => {
      const result = detectBobSessionError({
        exitCode: 0,
        stdout: "Starting new session...",
        stderr: "",
      });

      expect(result).toBe(false);
    });
  });

  describe("detectBobMaxTurns", () => {
    it("should detect maximum turns reached", () => {
      const result = detectBobMaxTurns({
        exitCode: 1,
        stdout: "Error: Maximum turns limit reached",
        stderr: "",
      });

      expect(result).toBe(true);
    });

    it("should detect turn limit exceeded", () => {
      const result = detectBobMaxTurns({
        exitCode: 1,
        stdout: "",
        stderr: "Turn limit exceeded (50/50)",
      });

      expect(result).toBe(true);
    });

    it("should detect too many turns", () => {
      const result = detectBobMaxTurns({
        exitCode: 1,
        stdout: "Error: Too many turns in conversation",
        stderr: "",
      });

      expect(result).toBe(true);
    });

    it("should not detect max turns in normal output", () => {
      const result = detectBobMaxTurns({
        exitCode: 0,
        stdout: "Completed in 5 turns",
        stderr: "",
      });

      expect(result).toBe(false);
    });
  });

  describe("detectBobTimeout", () => {
    it("should detect timeout from timedOut flag", () => {
      const result = detectBobTimeout({
        timedOut: true,
        exitCode: null,
        stdout: "",
        stderr: "",
      });

      expect(result).toBe(true);
    });

    it("should detect timeout from output", () => {
      const result = detectBobTimeout({
        timedOut: false,
        exitCode: 124,
        stdout: "",
        stderr: "Error: Execution timed out after 300s",
      });

      expect(result).toBe(true);
    });

    it("should not detect timeout in normal runs", () => {
      const result = detectBobTimeout({
        timedOut: false,
        exitCode: 0,
        stdout: "Task completed",
        stderr: "",
      });

      expect(result).toBe(false);
    });
  });

  describe("classifyBobError", () => {
    it("should classify timeout errors", () => {
      const result = classifyBobError({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        stdout: "",
        stderr: "",
      });

      expect(result.type).toBe("timeout");
      expect(result.isRetryable).toBe(false);
      expect(result.message).toContain("timed out");
    });

    it("should classify auth errors", () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Authentication required",
      });

      expect(result.type).toBe("auth");
      expect(result.isRetryable).toBe(false);
      expect(result.message).toContain("Authentication");
    });

    it("should classify session errors as retryable", () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Session not found",
      });

      expect(result.type).toBe("session");
      expect(result.isRetryable).toBe(true);
      expect(result.message).toContain("Session error");
    });

    it("should classify max turns errors", () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "Maximum turns reached",
        stderr: "",
      });

      expect(result.type).toBe("max_turns");
      expect(result.isRetryable).toBe(false);
      expect(result.message).toContain("Maximum turns");
    });

    it("should classify unknown errors", () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Some random error",
      });

      expect(result.type).toBe("execution");
      expect(result.code).toBe("execution_error");
      expect(result.isRetryable).toBe(false);
      expect(result.message).toContain("exited with code 1");
    });
  });

  describe("describeBobFailure", () => {
    it("should describe timeout failures", () => {
      const result = describeBobFailure({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        stdout: "",
        stderr: "",
      });

      expect(result).toContain("Bob Shell run failed");
      expect(result).toContain("type=timeout");
      expect(result).toContain("signal=SIGTERM");
    });

    it("should describe auth failures", () => {
      const result = describeBobFailure({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Invalid API key",
      });

      expect(result).toContain("Bob Shell run failed");
      expect(result).toContain("type=auth");
      expect(result).toContain("exitCode=1");
      expect(result).toContain("Invalid API key");
    });

    it("should describe session failures", () => {
      const result = describeBobFailure({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Session abc123 not found",
      });

      expect(result).toContain("Bob Shell run failed");
      expect(result).toContain("type=session");
      expect(result).toContain("Session error");
    });

    it("should describe max turns failures", () => {
      const result = describeBobFailure({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "Maximum turns limit reached",
        stderr: "",
      });

      expect(result).toContain("Bob Shell run failed");
      expect(result).toContain("type=max_turns");
      expect(result).toContain("Maximum turns");
    });
  });
});
