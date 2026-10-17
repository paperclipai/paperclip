/**
 * The one gate in front of the "import the local Claude config" credential mode.
 *
 * Four surfaces offer that mode and they agree through this function rather than
 * through four copies of the conditions (PRODUCT #1, #50). These cases are what
 * each of those surfaces is then asserting end to end in its own suite: the exact
 * shape of the answer, including the two halves a surface must not add for itself.
 */

import { describe, expect, it } from "vitest";
import { canOfferClaudeConfigImport, type ClaudeConfigImportHealth } from "./claude-config-import";

/** A `local_trusted` instance's health answer — the only kind the import lives on. */
const LOCALLY_TRUSTED = {
  status: "ok" as const,
  deploymentMode: "local_trusted" as const,
  localAiLoginSupported: true,
};

describe("canOfferClaudeConfigImport", () => {
  it("offers it to Anthropic on a locally trusted instance that reads local credentials", () => {
    expect(canOfferClaudeConfigImport({ provider: "anthropic", health: LOCALLY_TRUSTED })).toBe(true);
  });

  it.each(["openai", "openrouter", "xai", "codex_local", undefined])(
    "does not offer it for %s",
    (provider) => {
      // Endpoint fields mean nothing on any other provider (PRODUCT #3).
      expect(canOfferClaudeConfigImport({ provider, health: LOCALLY_TRUSTED })).toBe(false);
    },
  );

  it.each<[string, ClaudeConfigImportHealth]>([
    ["a hosted instance", { ...LOCALLY_TRUSTED, deploymentMode: "authenticated" as const }],
    ["an instance that has not opted into local sign-in", { ...LOCALLY_TRUSTED, localAiLoginSupported: false }],
    ["an instance that reports no deployment mode", { localAiLoginSupported: true }],
    ["an instance that reports neither", {}],
  ])("does not offer it on %s", (_label, health) => {
    // The instance half, read off the same health answer the local sign-in reads
    // (PRODUCT #4, #5, #43). No fallback from `deploymentMode` to
    // `localAiLoginSupported`: the second is the instance's own answer about
    // whether it may read local credentials, and inferring it would offer the mode
    // to an instance that just said it could not.
    expect(canOfferClaudeConfigImport({ provider: "anthropic", health })).toBe(false);
  });

  it("does not offer it before the health answer has landed", () => {
    // A gate read off a payload that has not arrived is not the gate: drawing the
    // mode for a beat and withdrawing it is worse than not drawing it yet.
    expect(canOfferClaudeConfigImport({ provider: "anthropic", health: undefined })).toBe(false);
  });
});
