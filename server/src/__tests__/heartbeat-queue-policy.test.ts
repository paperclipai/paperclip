import { describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import {
  normalizeMaxQueuedRuns,
  parseHeartbeatPolicy,
} from "../services/heartbeat.ts";

function buildAgent(runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    name: "TestAgent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("normalizeMaxQueuedRuns", () => {
  it("returns default (5) when value is undefined", () => {
    expect(normalizeMaxQueuedRuns(undefined)).toBe(5);
  });

  it("returns default (5) when value is null", () => {
    expect(normalizeMaxQueuedRuns(null)).toBe(5);
  });

  it("returns default (5) when value is a non-numeric string", () => {
    expect(normalizeMaxQueuedRuns("banana")).toBe(5);
  });

  it("clamps to minimum of 1", () => {
    expect(normalizeMaxQueuedRuns(0)).toBe(1);
    expect(normalizeMaxQueuedRuns(-10)).toBe(1);
  });

  it("clamps to maximum of 50", () => {
    expect(normalizeMaxQueuedRuns(51)).toBe(50);
    expect(normalizeMaxQueuedRuns(1000)).toBe(50);
  });

  it("floors fractional values", () => {
    expect(normalizeMaxQueuedRuns(3.9)).toBe(3);
    expect(normalizeMaxQueuedRuns(7.1)).toBe(7);
  });

  it("accepts a valid integer within range", () => {
    expect(normalizeMaxQueuedRuns(10)).toBe(10);
    expect(normalizeMaxQueuedRuns(1)).toBe(1);
    expect(normalizeMaxQueuedRuns(50)).toBe(50);
  });

  it("treats string values as non-numeric and falls back to default", () => {
    expect(normalizeMaxQueuedRuns("15")).toBe(5);
  });
});

describe("parseHeartbeatPolicy — maxQueuedRuns field", () => {
  it("uses default of 5 when maxQueuedRuns is not set", () => {
    const agent = buildAgent({ heartbeat: { enabled: true } });
    const policy = parseHeartbeatPolicy(agent);
    expect(policy.maxQueuedRuns).toBe(5);
  });

  it("uses default of 5 when runtimeConfig has no heartbeat key", () => {
    const agent = buildAgent({});
    const policy = parseHeartbeatPolicy(agent);
    expect(policy.maxQueuedRuns).toBe(5);
  });

  it("respects configured maxQueuedRuns", () => {
    const agent = buildAgent({ heartbeat: { maxQueuedRuns: 3 } });
    const policy = parseHeartbeatPolicy(agent);
    expect(policy.maxQueuedRuns).toBe(3);
  });

  it("clamps oversize maxQueuedRuns to 50", () => {
    const agent = buildAgent({ heartbeat: { maxQueuedRuns: 200 } });
    const policy = parseHeartbeatPolicy(agent);
    expect(policy.maxQueuedRuns).toBe(50);
  });

  it("coexists correctly with maxConcurrentRuns in policy output", () => {
    const agent = buildAgent({
      heartbeat: { maxConcurrentRuns: 2, maxQueuedRuns: 8 },
    });
    const policy = parseHeartbeatPolicy(agent);
    expect(policy.maxConcurrentRuns).toBe(2);
    expect(policy.maxQueuedRuns).toBe(8);
  });
});
