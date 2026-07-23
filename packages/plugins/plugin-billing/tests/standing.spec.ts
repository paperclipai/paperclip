import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { applyStandingCommand, standingWriterFromContext } from "../src/standing.js";

function fakeCtx() {
  const setStanding = vi.fn(async () => {});
  const clearStanding = vi.fn(async () => {});
  const ctx = { companies: { setStanding, clearStanding } } as unknown as PluginContext;
  return { ctx, setStanding, clearStanding };
}

describe("standingWriterFromContext", () => {
  it("forwards set() to ctx.companies.setStanding with the exact PR-3 payload", async () => {
    const { ctx, setStanding } = fakeCtx();
    const writer = standingWriterFromContext(ctx);
    await writer.set("co-1", {
      status: "blocked",
      reason: "awaiting_subscription",
      message: "Needs a subscription.",
      actionUrl: "company/settings/billing",
    });
    expect(setStanding).toHaveBeenCalledExactlyOnceWith("co-1", {
      status: "blocked",
      reason: "awaiting_subscription",
      message: "Needs a subscription.",
      actionUrl: "company/settings/billing",
    });
  });

  it("forwards clear() to ctx.companies.clearStanding", async () => {
    const { ctx, clearStanding } = fakeCtx();
    await standingWriterFromContext(ctx).clear("co-2");
    expect(clearStanding).toHaveBeenCalledExactlyOnceWith("co-2");
  });
});

describe("applyStandingCommand", () => {
  it("routes set/clear commands", async () => {
    const set = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const writer = { set, clear };
    await applyStandingCommand(writer, "co-1", { kind: "clear" });
    expect(clear).toHaveBeenCalledExactlyOnceWith("co-1");
    await applyStandingCommand(writer, "co-1", {
      kind: "set", status: "grace", reason: "trial_ended", message: "m", actionUrl: "a",
    });
    expect(set).toHaveBeenCalledExactlyOnceWith("co-1", {
      status: "grace", reason: "trial_ended", message: "m", actionUrl: "a",
    });
  });
});
