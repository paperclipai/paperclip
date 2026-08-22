import { describe, expect, it } from "vitest";
import type { AcpRuntimeStatus } from "acpx/runtime";

import { readAcpxSessionModelId, resolveAcpxEffectiveModel } from "./model-attribution.js";

function statusWithModel(currentModelId: string | undefined): AcpRuntimeStatus {
  return {
    models: {
      currentModelId,
      availableModelIds: ["default", "opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku"],
    },
  } as AcpRuntimeStatus;
}

describe("readAcpxSessionModelId", () => {
  it("returns the concrete model id the session reports", () => {
    expect(readAcpxSessionModelId(statusWithModel("claude-fable-5[1m]"))).toBe("claude-fable-5[1m]");
  });

  it("trims surrounding whitespace", () => {
    expect(readAcpxSessionModelId(statusWithModel("  claude-sonnet-4-6 "))).toBe("claude-sonnet-4-6");
  });

  it.each(["default", "Default", "DEFAULT", "auto", "unknown", "", "   "])(
    "rejects the placeholder id %j so it is never recorded as a model",
    (placeholder) => {
      expect(readAcpxSessionModelId(statusWithModel(placeholder))).toBeNull();
    },
  );

  it("returns null when the session advertises no model state", () => {
    expect(readAcpxSessionModelId({} as AcpRuntimeStatus)).toBeNull();
    expect(readAcpxSessionModelId(null)).toBeNull();
    expect(readAcpxSessionModelId(undefined)).toBeNull();
  });

  it("returns null when currentModelId is not a string", () => {
    const status = { models: { currentModelId: 42, availableModelIds: [] } } as unknown as AcpRuntimeStatus;
    expect(readAcpxSessionModelId(status)).toBeNull();
  });
});

describe("resolveAcpxEffectiveModel", () => {
  it("prefers the post-turn session model over the request", () => {
    expect(
      resolveAcpxEffectiveModel({
        postStatus: statusWithModel("opus[1m]"),
        preStatus: statusWithModel("sonnet"),
        requestedModel: "claude-sonnet-5",
      }),
    ).toEqual({ model: "opus[1m]", source: "session" });
  });

  it("falls back to the pre-turn session model when the post-turn read fails", () => {
    expect(
      resolveAcpxEffectiveModel({
        postStatus: null,
        preStatus: statusWithModel("claude-sonnet-4-6"),
        requestedModel: "claude-sonnet-5",
      }),
    ).toEqual({ model: "claude-sonnet-4-6", source: "session" });
  });

  it("skips a placeholder post-turn model in favour of a concrete pre-turn one", () => {
    expect(
      resolveAcpxEffectiveModel({
        postStatus: statusWithModel("default"),
        preStatus: statusWithModel("claude-fable-5[1m]"),
      }),
    ).toEqual({ model: "claude-fable-5[1m]", source: "session" });
  });

  it("falls back to the requested model when no session model state exists", () => {
    expect(
      resolveAcpxEffectiveModel({
        postStatus: statusWithModel("default"),
        preStatus: statusWithModel(""),
        requestedModel: "claude-opus-5",
      }),
    ).toEqual({ model: "claude-opus-5", source: "requested" });
  });

  it("reports unknown rather than a placeholder when neither source resolves", () => {
    expect(
      resolveAcpxEffectiveModel({
        postStatus: statusWithModel("default"),
        preStatus: null,
        requestedModel: "",
      }),
    ).toEqual({ model: null, source: "unknown" });
  });

  it("treats a whitespace-only requested model as absent", () => {
    expect(resolveAcpxEffectiveModel({ requestedModel: "   " })).toEqual({
      model: null,
      source: "unknown",
    });
  });

  it("recovers attribution for the unset-config case that produced model='unknown'", () => {
    // Agents that leave `adapterConfig.model` unset let the ACP server pick. The
    // engine used to report only the (empty) request, so every cost event they
    // produced was recorded as `unknown` even though the session knew the model.
    const beforeFix = { model: "", source: "unknown" };
    const afterFix = resolveAcpxEffectiveModel({
      postStatus: statusWithModel("claude-fable-5[1m]"),
      requestedModel: "",
    });
    expect(beforeFix.model || null).toBeNull();
    expect(afterFix).toEqual({ model: "claude-fable-5[1m]", source: "session" });
  });
});
