import { describe as vitestDescribe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectSchemaDriftViolations,
  describe as describeSchema,
  diffObjectSchemas,
  formatViolations,
  SCHEMA_DRIFT_CASES,
} from "./schema-drift.js";

vitestDescribe("MCP tool / REST validator schema drift", () => {
  it("reports no drift across the registered tool/route pairs", () => {
    const violations = collectSchemaDriftViolations();
    // A readable failure message is worth more than a bare boolean here.
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("covers the write-oriented tools that forward a body to a REST route", () => {
    const covered = SCHEMA_DRIFT_CASES.map((c) => c.tool);
    for (const tool of [
      "paperclipCreateIssue",
      "paperclipUpdateIssue",
      "paperclipAddComment",
      "paperclipCheckoutIssue",
      "paperclipUpsertIssueDocument",
      "paperclipCreateApproval",
      "paperclipLinkIssueApproval",
      "paperclipSuggestTasks",
      "paperclipAskUserQuestions",
      "paperclipRequestConfirmation",
      "paperclipRequestCheckboxConfirmation",
    ]) {
      expect(covered).toContain(tool);
    }
  });
});

vitestDescribe("schema-drift comparator", () => {
  it("treats an identical shape as no drift", () => {
    const a = z.object({ name: z.string(), count: z.number().optional() });
    const b = z.object({ name: z.string(), count: z.number().optional() });
    expect(diffObjectSchemas(a, b)).toEqual([]);
  });

  it("detects a field missing on the tool side", () => {
    const tool = z.object({ name: z.string() });
    const rest = z.object({ name: z.string(), extra: z.string() });
    const diffs = diffObjectSchemas(tool, rest);
    expect(diffs.map((d) => d.path)).toEqual(["extra"]);
  });

  it("detects a field present only on the tool side", () => {
    const tool = z.object({ name: z.string(), rogue: z.string() });
    const rest = z.object({ name: z.string() });
    const diffs = diffObjectSchemas(tool, rest);
    expect(diffs.map((d) => d.path)).toEqual(["rogue"]);
  });

  it("detects a base type change", () => {
    const tool = z.object({ id: z.string() });
    const rest = z.object({ id: z.number() });
    expect(diffObjectSchemas(tool, rest)[0].detail).toMatch(/type differs/);
  });

  it("detects an optionality change", () => {
    const tool = z.object({ id: z.string().optional() });
    const rest = z.object({ id: z.string() });
    expect(diffObjectSchemas(tool, rest)[0].detail).toMatch(/optionality differs/);
  });

  it("detects diverging enum members", () => {
    const tool = z.object({ status: z.enum(["a", "b"]) });
    const rest = z.object({ status: z.enum(["a", "b", "c"]) });
    expect(diffObjectSchemas(tool, rest)[0].detail).toMatch(/enum members differ/);
  });

  it("honors the allowlist for a documented divergence", () => {
    const tool = z.object({ name: z.string(), format: z.enum(["markdown"]).default("markdown") });
    const rest = z.object({ name: z.string(), format: z.enum(["markdown"]) });
    expect(diffObjectSchemas(tool, rest)).not.toEqual([]);
    expect(diffObjectSchemas(tool, rest, ["format"])).toEqual([]);
  });

  it("recurses into nested object shapes", () => {
    const tool = z.object({ payload: z.object({ a: z.string() }) });
    const rest = z.object({ payload: z.object({ a: z.string(), b: z.string() }) });
    expect(diffObjectSchemas(tool, rest).map((d) => d.path)).toEqual(["payload.b"]);
  });

  it("unwraps default/effects/pipeline to the semantic core type", () => {
    const desc = describeSchema(
      z.preprocess((v) => v, z.string()).default("x"),
    );
    expect(desc).toMatchObject({ kind: "ZodString", optional: true });
  });
});
