import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterQuotaContext } from "@paperclipai/adapter-utils";
import { getQuotaWindows } from "./quota.js";

describe("getQuotaWindows execution-target context", () => {
  let previousBedrock: string | undefined;

  beforeEach(() => {
    // Force the Bedrock short-circuit so the host probe is deterministic. This
    // path needs no network, no config files, and no Claude CLI. Both call
    // shapes must return this same host result.
    previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  });

  afterEach(() => {
    if (previousBedrock === undefined) {
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    } else {
      process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock;
    }
  });

  it("accepts an optional context and keeps the host result for a null target", async () => {
    const hostResult = await getQuotaWindows();
    const nullTargetResult = await getQuotaWindows({ executionTarget: null });

    expect(nullTargetResult).toEqual(hostResult);
    expect(hostResult).toEqual({
      provider: "anthropic",
      source: "bedrock",
      ok: true,
      windows: [],
    });
  });

  it("accepts both the absent and the null-target call shapes", async () => {
    // The type must accept a call with no argument and a call with an explicit
    // context object.
    const ctx: AdapterQuotaContext = { executionTarget: null };
    await expect(getQuotaWindows()).resolves.toBeDefined();
    await expect(getQuotaWindows(ctx)).resolves.toBeDefined();
  });
});
