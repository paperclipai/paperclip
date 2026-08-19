import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { prpSchemaBundle } from "../protocol/generated/schema-bundle.js";
import {
  loadPaperclipNativeExecutionFixture,
  paperclipNativeExecutionFixtureUrl,
  paperclipNativeExecutionSchemaUrl,
  parsePaperclipNativeExecution,
} from "./native-execution.js";
import { PAPERCLIP_RUNNER_BUILD_METADATA } from "./build-metadata.js";

describe("paperclip-runner/native-execution/v1", () => {
  it("keeps the shipped seeded fixture valid against the published JSON Schema", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const schema of Object.values(prpSchemaBundle)) ajv.addSchema(schema);
    const schema = JSON.parse(
      await readFile(paperclipNativeExecutionSchemaUrl, "utf8"),
    ) as Record<string, unknown>;
    const validate = ajv.compile(schema);
    const fixture = JSON.parse(
      await readFile(paperclipNativeExecutionFixtureUrl, "utf8"),
    ) as unknown;

    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("loads the shipped seeded attempt and preserves nested additive fields", async () => {
    const bundle = await loadPaperclipNativeExecutionFixture();
    expect(bundle.provenance).toBe("seeded");
    expect(bundle.semanticTools.results).toEqual([
      expect.objectContaining({ outcome: "denied", callId: "call_evals_seeded" }),
    ]);
    expect(bundle.semanticTools.denials).toHaveLength(1);
    expect(bundle.transcript).toMatchObject({ complete: true, eventCount: 4 });
    expect(bundle.usage.cost).toEqual({ currency: "USD", amountMicros: 0 });
    expect(bundle.runner.package).toEqual(PAPERCLIP_RUNNER_BUILD_METADATA.package);
    expect(bundle.runner.catalogSha256).toBe(
      PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog.sha256,
    );
    expect(bundle.x_fixturePurpose).toContain("additive field preservation");

    const extended = structuredClone(bundle);
    extended.identity.x_identity = "identity-extension";
    extended.input.x_input = "input-extension";
    extended.runner.x_runner = "runner-extension";
    extended.runner.package.x_package = "package-extension";
    extended.runner.binary.x_binary = "binary-extension";
    extended.semanticTools.x_semanticTools = "semantic-extension";
    extended.usage.x_usage = "usage-extension";
    extended.usage.cost!.x_cost = "cost-extension";

    expect(parsePaperclipNativeExecution(extended)).toMatchObject({
      identity: { x_identity: "identity-extension" },
      input: { x_input: "input-extension" },
      runner: {
        x_runner: "runner-extension",
        package: { x_package: "package-extension" },
        binary: { x_binary: "binary-extension" },
      },
      semanticTools: { x_semanticTools: "semantic-extension" },
      usage: { x_usage: "usage-extension", cost: { x_cost: "cost-extension" } },
    });
  });

  it("rejects unknown native schema versions", async () => {
    const bundle = await loadPaperclipNativeExecutionFixture();
    expect(() => parsePaperclipNativeExecution({ ...bundle, schema: "paperclip-runner/native-execution/v2" }))
      .toThrow(/unsupported schema/);
  });

  it("rejects a terminal that conflicts with the event stream", async () => {
    const bundle = await loadPaperclipNativeExecutionFixture();
    expect(() => parsePaperclipNativeExecution({
      ...bundle,
      terminal: { ...bundle.terminal, runTerminalState: "failed" },
    })).toThrow(/must equal the run\.terminal event payload/);
  });

  it("rejects missing denial receipts and incomplete transcript ambiguity", async () => {
    const bundle = await loadPaperclipNativeExecutionFixture();
    expect(() => parsePaperclipNativeExecution({
      ...bundle,
      semanticTools: { ...bundle.semanticTools, denials: [] },
    })).toThrow(/needs a denial receipt/);
    expect(() => parsePaperclipNativeExecution({
      ...bundle,
      transcript: { ...bundle.transcript, complete: false, omissionReason: null },
    })).toThrow(/omissionReason.*required/);
  });

  it("rejects semantic indexes that reinterpret or omit PRP tool events", async () => {
    const bundle = await loadPaperclipNativeExecutionFixture();
    const mismatched = structuredClone(bundle);
    const resultPayload = mismatched.events[1]!.payload as {
      semantic_tool: { outcome: string };
    };
    resultPayload.semantic_tool.outcome = "succeeded";
    expect(() => parsePaperclipNativeExecution(mismatched))
      .toThrow(/does not match semantic envelope/);

    const mismatchedCorrelation = structuredClone(bundle);
    const inputPayload = mismatchedCorrelation.events[0]!.payload as {
      semantic_tool: { correlation: { runId: string } };
    };
    inputPayload.semantic_tool.correlation.runId = "other_run";
    expect(() => parsePaperclipNativeExecution(mismatchedCorrelation))
      .toThrow(/correlation\.runId.*enclosing event/);

    expect(() => parsePaperclipNativeExecution({
      ...bundle,
      semanticTools: { ...bundle.semanticTools, calls: [] },
    })).toThrow(/no matching call|tool-input event .* is not indexed/);
  });

  it("rejects unordered native events", async () => {
    const bundle = await loadPaperclipNativeExecutionFixture();
    const events = structuredClone(bundle.events);
    events[1] = { ...events[1]!, sourceSeq: 1 };
    expect(() => parsePaperclipNativeExecution({ ...bundle, events }))
      .toThrow(/must be ordered after 1/);

    const duplicateIds = structuredClone(bundle.events);
    duplicateIds[1] = {
      ...duplicateIds[1]!,
      sourceEventId: duplicateIds[0]!.sourceEventId,
    };
    expect(() => parsePaperclipNativeExecution({ ...bundle, events: duplicateIds }))
      .toThrow(/sourceEventId.*unique/);
  });
});
