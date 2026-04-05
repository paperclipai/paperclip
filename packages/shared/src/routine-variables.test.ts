import { describe, expect, it } from "vitest";
import {
  extractRoutineVariableNames,
  interpolateRoutineTemplate,
  syncRoutineVariablesWithTemplate,
} from "./routine-variables.js";

describe("routine variable helpers", () => {
  it("extracts placeholder names in first-appearance order", () => {
    expect(
      extractRoutineVariableNames("Review {{repo}} and {{priority}} for {{repo}}"),
    ).toEqual(["repo", "priority"]);
  });

  it("preserves existing metadata when syncing variables from a template", () => {
    expect(
      syncRoutineVariablesWithTemplate("Review {{repo}} and {{priority}}", [
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
});
