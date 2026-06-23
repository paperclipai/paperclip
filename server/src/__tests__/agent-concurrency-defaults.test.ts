import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV,
  normalizeAgentMaxConcurrentRuns,
  resolveAgentDefaultMaxConcurrentRuns,
} from "../services/agent-concurrency-defaults.js";

describe("agent concurrency defaults", () => {
  it("uses the shared default when the environment override is unset or invalid", () => {
    expect(resolveAgentDefaultMaxConcurrentRuns({})).toBe(1);
    expect(resolveAgentDefaultMaxConcurrentRuns({ [AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]: "" })).toBe(1);
    expect(resolveAgentDefaultMaxConcurrentRuns({ [AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]: "not-a-number" })).toBe(1);
  });

  it("reads and clamps PAPERCLIP_AGENT_DEFAULT_MAX_CONCURRENT_RUNS", () => {
    expect(resolveAgentDefaultMaxConcurrentRuns({ [AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]: "3" })).toBe(3);
    expect(resolveAgentDefaultMaxConcurrentRuns({ [AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]: "3.9" })).toBe(3);
    expect(resolveAgentDefaultMaxConcurrentRuns({ [AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]: "0" })).toBe(1);
    expect(resolveAgentDefaultMaxConcurrentRuns({ [AGENT_DEFAULT_MAX_CONCURRENT_RUNS_ENV]: "100" })).toBe(50);
  });

  it("normalizes explicit heartbeat values with a supplied fallback", () => {
    expect(normalizeAgentMaxConcurrentRuns(undefined, 4)).toBe(4);
    expect(normalizeAgentMaxConcurrentRuns("2", 4)).toBe(2);
    expect(normalizeAgentMaxConcurrentRuns("invalid", 4)).toBe(4);
  });
});
