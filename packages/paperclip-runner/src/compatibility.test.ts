import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_RUNNER_COMPATIBILITY,
  PaperclipRunnerCompatibilityError,
  assertPaperclipRunnerCompatibility,
} from "./compatibility.js";

describe("runner compatibility preflight", () => {
  it("keeps the compatibility manifest synchronized with the package version", () => {
    const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(PAPERCLIP_RUNNER_COMPATIBILITY.packageVersion).toBe(manifest.version);
  });

  it("accepts the supported product/test/eval bundle", () => {
    expect(assertPaperclipRunnerCompatibility({
      consumer: "paperclip-evals",
      components: {
        catalog: 1,
        protocol: 1,
        runnerClient: 1,
        controlPlaneAdapter: 1,
        testkit: 1,
      },
      evalCorpusVersion: 1,
      requiredOperationIds: ["get_task_context", "finish_task"],
      provider: {
        id: "codex-app-server",
        supportedOperationIds: ["get_task_context", "finish_task"],
      },
    })).toBe(PAPERCLIP_RUNNER_COMPATIBILITY);
  });

  it("fails with stable component, corpus, catalog, and provider issues", () => {
    expect(() => assertPaperclipRunnerCompatibility({
      consumer: "incompatible-eval-bundle",
      components: { protocol: 2 },
      evalCorpusVersion: 2,
      requiredOperationIds: ["missing_operation", "finish_task"],
      provider: { id: "limited-provider", supportedOperationIds: [] },
    })).toThrow(PaperclipRunnerCompatibilityError);

    try {
      assertPaperclipRunnerCompatibility({
        consumer: "incompatible-eval-bundle",
        components: { protocol: 2 },
        evalCorpusVersion: 2,
        requiredOperationIds: ["missing_operation", "finish_task"],
        provider: { id: "limited-provider", supportedOperationIds: [] },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PaperclipRunnerCompatibilityError);
      expect((error as PaperclipRunnerCompatibilityError).code).toBe("paperclip_runner_incompatible");
      expect((error as PaperclipRunnerCompatibilityError).issues.map((issue) => issue.code)).toEqual([
        "component_version_mismatch",
        "eval_corpus_version_unsupported",
        "catalog_operation_unknown",
        "provider_operation_unsupported",
      ]);
    }
  });

  it("requires explicit provider capabilities when operations are required", () => {
    expect(() => assertPaperclipRunnerCompatibility({
      consumer: "undeclared-provider",
      requiredOperationIds: ["finish_task"],
    })).toThrow(/provider_capabilities_missing/);
  });
});
