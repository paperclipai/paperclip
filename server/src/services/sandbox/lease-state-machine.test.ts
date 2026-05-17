import { describe, expect, it } from "vitest";
import {
  IllegalSandboxLeaseTransitionError,
  SANDBOX_LEASE_STATES,
  TERMINAL_SANDBOX_LEASE_STATES,
  assertSandboxLeaseTransition,
  canTransitionSandboxLease,
  isTerminalSandboxLeaseState,
  listAllowedSandboxLeaseTransitions,
  type SandboxLeaseState,
} from "./lease-state-machine.js";

describe("sandbox lease state machine", () => {
  it("allows the happy-path lifecycle", () => {
    const happy: SandboxLeaseState[] = [
      "requested",
      "provisioning",
      "running",
      "collecting",
      "cleanup",
      "expired",
    ];
    for (let i = 0; i < happy.length - 1; i += 1) {
      expect(canTransitionSandboxLease(happy[i]!, happy[i + 1]!)).toBe(true);
    }
  });

  it("allows fail transitions from every non-terminal state", () => {
    for (const state of SANDBOX_LEASE_STATES) {
      if (TERMINAL_SANDBOX_LEASE_STATES.has(state)) continue;
      expect(canTransitionSandboxLease(state, "failed")).toBe(true);
    }
  });

  it("rejects self-transitions", () => {
    for (const state of SANDBOX_LEASE_STATES) {
      expect(canTransitionSandboxLease(state, state)).toBe(false);
    }
  });

  it("rejects transitions out of terminal states", () => {
    for (const terminal of TERMINAL_SANDBOX_LEASE_STATES) {
      for (const state of SANDBOX_LEASE_STATES) {
        expect(canTransitionSandboxLease(terminal, state)).toBe(false);
      }
    }
  });

  it("rejects backward transitions like running -> requested", () => {
    expect(canTransitionSandboxLease("running", "requested")).toBe(false);
    expect(canTransitionSandboxLease("collecting", "running")).toBe(false);
    expect(canTransitionSandboxLease("cleanup", "running")).toBe(false);
    expect(canTransitionSandboxLease("provisioning", "requested")).toBe(false);
  });

  it("rejects illegal forward transitions like requested -> running", () => {
    expect(canTransitionSandboxLease("requested", "running")).toBe(false);
    expect(canTransitionSandboxLease("requested", "collecting")).toBe(false);
    expect(canTransitionSandboxLease("running", "expired")).toBe(true);
    expect(canTransitionSandboxLease("provisioning", "collecting")).toBe(false);
  });

  it("assertSandboxLeaseTransition throws IllegalSandboxLeaseTransitionError on illegal moves", () => {
    expect(() => assertSandboxLeaseTransition("requested", "running")).toThrow(
      IllegalSandboxLeaseTransitionError,
    );
    expect(() => assertSandboxLeaseTransition("expired", "running")).toThrow(
      IllegalSandboxLeaseTransitionError,
    );
  });

  it("isTerminalSandboxLeaseState only returns true for terminal states", () => {
    expect(isTerminalSandboxLeaseState("expired")).toBe(true);
    expect(isTerminalSandboxLeaseState("failed")).toBe(true);
    expect(isTerminalSandboxLeaseState("running")).toBe(false);
    expect(isTerminalSandboxLeaseState("cleanup")).toBe(false);
  });

  it("listAllowedSandboxLeaseTransitions returns the configured set", () => {
    expect(listAllowedSandboxLeaseTransitions("requested").sort()).toEqual([
      "failed",
      "provisioning",
    ]);
    expect(listAllowedSandboxLeaseTransitions("expired")).toEqual([]);
  });
});
