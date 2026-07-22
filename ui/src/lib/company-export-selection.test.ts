import { describe, expect, it } from "vitest";
import { buildInitialExportCheckedFiles } from "./company-export-selection";

describe("buildInitialExportCheckedFiles", () => {
  it("checks non-task files and recurring task packages by default", () => {
    const checked = buildInitialExportCheckedFiles(
      [
        "README.md",
        ".paperclip.yaml",
        "tasks/one-off/TASK.md",
        "tasks/recurring/TASK.md",
        "tasks/recurring/notes.md",
      ],
      [
        { path: "tasks/one-off/TASK.md", recurring: false },
        { path: "tasks/recurring/TASK.md", recurring: true },
      ],
      new Set<string>(),
    );

    expect(Array.from(checked).sort()).toEqual([
      ".paperclip.yaml",
      "README.md",
      "tasks/recurring/TASK.md",
      "tasks/recurring/notes.md",
    ]);
  });

  it("preserves previous manual selections for one-time tasks", () => {
    const checked = buildInitialExportCheckedFiles(
      ["README.md", "tasks/one-off/TASK.md"],
      [{ path: "tasks/one-off/TASK.md", recurring: false }],
      new Set(["tasks/one-off/TASK.md"]),
    );

    expect(Array.from(checked).sort()).toEqual([
      "README.md",
      "tasks/one-off/TASK.md",
    ]);
  });
});
