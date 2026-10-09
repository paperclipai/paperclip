import { describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  isArchivedStackRecoveryError,
  isTenantSessionRecoveryError,
} from "./tenant-session-recovery";

describe("isTenantSessionRecoveryError", () => {
  it.each(["tenant_session_required", "tenant_session_invalid"])(
    "recognizes the %s Cloud tenant-session error",
    (error) => {
      expect(isTenantSessionRecoveryError(401, { error })).toBe(true);
    },
  );

  it.each([
    [403, { error: "tenant_session_required" }],
    [401, { error: "unauthorized" }],
    [401, { error: "tenant_session_required " }],
    [401, { error: { code: "tenant_session_required" } }],
    [401, { details: { error: "tenant_session_required" } }],
    [401, null],
  ])("rejects status/body combination %j %j", (status, body) => {
    expect(isTenantSessionRecoveryError(status, body)).toBe(false);
  });
});

describe("isArchivedStackRecoveryError", () => {
  it("recognizes a 423 archived status-page body", () => {
    expect(isArchivedStackRecoveryError(423, { statusPage: { code: "archived" } })).toBe(true);
  });

  it.each([
    [423, { statusPage: { code: "suspended" } }],
    [423, { statusPage: { code: "deleted" } }],
    [423, { error: "archived" }],
    [503, { statusPage: { code: "archived" } }],
    [423, { statusPage: null }],
    [423, null],
  ])("rejects status/body combination %j %j", (status, body) => {
    expect(isArchivedStackRecoveryError(status, body)).toBe(false);
  });
});

describe("tenant-session recovery coordinator", () => {
  it("reloads once and shares one never-settling promise across concurrent failures", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);

    const first = recovery.recoverIfNeeded(401, { error: "tenant_session_required" });
    const second = recovery.recoverIfNeeded(401, { error: "tenant_session_invalid" });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(reload).toHaveBeenCalledTimes(1);

    let settled = false;
    void first?.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("recovers an archived stack with the same top-level reload", () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);

    const recovered = recovery.recoverIfNeeded(423, { statusPage: { code: "archived" } });

    expect(recovered).not.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing for unrelated responses", () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);

    expect(recovery.recoverIfNeeded(401, { error: "unauthorized" })).toBeNull();
    expect(recovery.recoverIfNeeded(423, { statusPage: { code: "suspended" } })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
