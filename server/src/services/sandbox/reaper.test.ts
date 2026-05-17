import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS,
  decideSandboxLeaseReap,
  decideSandboxLeaseReapBatch,
  type SandboxReaperLeaseRow,
} from "./reaper.js";

const NOW = new Date("2026-05-16T12:00:00Z");

function row(overrides: Partial<SandboxReaperLeaseRow> = {}): SandboxReaperLeaseRow {
  return {
    id: "lease-1",
    status: "active",
    providerLeaseId: "sandbox://docker/env-1/abc",
    acquiredAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    lastUsedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    expiresAt: null,
    releasedAt: null,
    sandboxState: null,
    ...overrides,
  };
}

describe("sandbox reaper", () => {
  it("skips terminal rows (expired)", () => {
    const decision = decideSandboxLeaseReap(row({ status: "expired" }), {
      now: NOW,
      idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS,
    });
    expect(decision.decision).toBe("skip_terminal");
  });

  it("skips terminal rows (failed)", () => {
    const decision = decideSandboxLeaseReap(row({ status: "failed" }), {
      now: NOW,
      idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS,
    });
    expect(decision.decision).toBe("skip_terminal");
  });

  it("skips terminal sandbox state (failed) even if status still active", () => {
    const decision = decideSandboxLeaseReap(row({ sandboxState: "failed" }), {
      now: NOW,
      idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS,
    });
    expect(decision.decision).toBe("skip_terminal");
  });

  it("skips orphan rows with no providerLeaseId", () => {
    const decision = decideSandboxLeaseReap(row({ providerLeaseId: null }), {
      now: NOW,
      idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS,
    });
    expect(decision.decision).toBe("skip_orphan_no_provider_lease");
  });

  it("marks walltime-expired rows for reaping", () => {
    const decision = decideSandboxLeaseReap(
      row({ expiresAt: new Date(NOW.getTime() - 1) }),
      { now: NOW, idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS },
    );
    expect(decision.decision).toBe("mark_expired_walltime");
  });

  it("marks idle-timeout rows for reaping", () => {
    const decision = decideSandboxLeaseReap(
      row({ lastUsedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }),
      { now: NOW, idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS },
    );
    expect(decision.decision).toBe("mark_expired_idle");
  });

  it("keeps active rows that are within the idle window", () => {
    const decision = decideSandboxLeaseReap(row(), {
      now: NOW,
      idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS,
    });
    expect(decision.decision).toBe("skip_active");
  });

  it("is idempotent for terminal rows (same decision on repeat)", () => {
    const terminal = row({ status: "expired" });
    const a = decideSandboxLeaseReap(terminal, { now: NOW, idleTimeoutMs: 1 });
    const b = decideSandboxLeaseReap(terminal, { now: NOW, idleTimeoutMs: 1 });
    expect(a).toEqual(b);
  });

  it("is idempotent for orphan rows on repeat", () => {
    const orphan = row({ providerLeaseId: null });
    const a = decideSandboxLeaseReap(orphan, { now: NOW, idleTimeoutMs: 1 });
    const b = decideSandboxLeaseReap(orphan, { now: NOW, idleTimeoutMs: 1 });
    expect(a).toEqual(b);
  });

  it("decideSandboxLeaseReapBatch returns one decision per row", () => {
    const decisions = decideSandboxLeaseReapBatch(
      [
        row(),
        row({ id: "lease-2", status: "expired" }),
        row({ id: "lease-3", providerLeaseId: null }),
      ],
      { now: NOW, idleTimeoutMs: DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS },
    );
    expect(decisions.map((d) => d.decision)).toEqual([
      "skip_active",
      "skip_terminal",
      "skip_orphan_no_provider_lease",
    ]);
  });
});
