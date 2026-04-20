import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROUTINE_VARIABLE_NAMES,
  extractRoutineVariableNames,
  getBuiltinRoutineVariableValues,
  interpolateRoutineTemplate,
  isBuiltinRoutineVariable,
  syncRoutineVariablesWithTemplate,
} from "./routine-variables.js";

describe("routine variable helpers", () => {
  it("extracts placeholder names in first-appearance order", () => {
    expect(
      extractRoutineVariableNames("Review {{repo}} and {{priority}} for {{repo}}"),
    ).toEqual(["repo", "priority"]);
  });

  it("deduplicates placeholder names across the routine title and description", () => {
    expect(
      extractRoutineVariableNames([
        "Triage {{repo}}",
        "Review {{repo}} for {{priority}} bugs",
      ]),
    ).toEqual(["repo", "priority"]);
  });

  it("preserves existing metadata when syncing variables from a template", () => {
    expect(
      syncRoutineVariablesWithTemplate(["Triage {{repo}}", "Review {{repo}} and {{priority}}"], [
        { name: "repo", label: "Repository", type: "text", defaultValue: "paperclip", required: true, options: [] },
      ]),
    ).toEqual([
      { name: "repo", label: "Repository", type: "text", defaultValue: "paperclip", required: true, options: [] },
      { name: "priority", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("interpolates provided variable values into the routine template", () => {
    expect(
      interpolateRoutineTemplate("Review {{repo}} for {{priority}}", {
        repo: "paperclip",
        priority: "high",
      }),
    ).toBe("Review paperclip for high");
  });

  it("identifies built-in variable names", () => {
    expect(isBuiltinRoutineVariable("date")).toBe(true);
    expect(isBuiltinRoutineVariable("repo")).toBe(false);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("date")).toBe(true);
  });

  it("getBuiltinRoutineVariableValues returns date in YYYY-MM-DD format", () => {
    const values = getBuiltinRoutineVariableValues();
    expect(values.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(values.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("excludes built-in variables from syncRoutineVariablesWithTemplate", () => {
    const result = syncRoutineVariablesWithTemplate(
      "Daily report for {{date}} — {{repo}}",
      [],
    );
    expect(result).toEqual([
      { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("interpolates built-in date variable alongside user variables", () => {
    const builtins = getBuiltinRoutineVariableValues();
    const allVars = { ...builtins, repo: "paperclip" };
    expect(
      interpolateRoutineTemplate("Report for {{date}} on {{repo}}", allVars),
    ).toBe(`Report for ${builtins.date} on paperclip`);
  });
});
