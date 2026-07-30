import { describe, expect, it } from "vitest";
import {
  type ExportCategorySelection,
  type ExportSelectionIssue,
  buildDefaultExportCategorySelection,
  buildExportCheckedFiles,
  countExportFilesByCategory,
  isAttachmentsCategoryEnabled,
} from "./company-export-selection";

function attachment(sha256: string) {
  return {
    sha256,
    contentType: "application/octet-stream",
    originalFilename: null,
    byteSize: 1,
    commentIndex: null,
  };
}

const ROOT_FILES = [
  "README.md",
  "COMPANY.md",
  ".paperclip.yaml",
  "images/org-chart.png",
  "images/logo.png",
];

const FILE_PATHS = [
  ...ROOT_FILES,
  "agents/ceo/AGENT.md",
  "agents/ceo/instructions.md",
  "projects/growth/PROJECT.md",
  "skills/research/SKILL.md",
  "tasks/one-off/TASK.md",
  "tasks/one-off/documents/spec.md",
  "tasks/weekly-report/TASK.md",
  "blobs/aaa111",
  "blobs/bbb222",
];

const ISSUES: ExportSelectionIssue[] = [
  {
    path: "tasks/one-off/TASK.md",
    recurring: false,
    attachments: [attachment("aaa111")],
  },
  {
    path: "tasks/weekly-report/TASK.md",
    recurring: true,
    attachments: [attachment("bbb222")],
  },
];

function selection(overrides: Partial<ExportCategorySelection> = {}): ExportCategorySelection {
  return { ...buildDefaultExportCategorySelection(), ...overrides };
}

function checkedWith(overrides: Partial<ExportCategorySelection> = {}): string[] {
  return Array.from(
    buildExportCheckedFiles({
      filePaths: FILE_PATHS,
      issues: ISSUES,
      categories: selection(overrides),
    }),
  ).sort();
}

describe("buildExportCheckedFiles", () => {
  it("checks every file by default", () => {
    expect(checkedWith()).toEqual([...FILE_PATHS].sort());
  });

  it("excludes agent files when agents is off", () => {
    const checked = checkedWith({ agents: false });
    expect(checked).not.toContain("agents/ceo/AGENT.md");
    expect(checked).not.toContain("agents/ceo/instructions.md");
    expect(checked).toEqual(
      [...FILE_PATHS].filter((p) => !p.startsWith("agents/")).sort(),
    );
  });

  it("excludes project files when projects is off", () => {
    expect(checkedWith({ projects: false })).toEqual(
      [...FILE_PATHS].filter((p) => !p.startsWith("projects/")).sort(),
    );
  });

  it("excludes skill files when skills is off", () => {
    expect(checkedWith({ skills: false })).toEqual(
      [...FILE_PATHS].filter((p) => !p.startsWith("skills/")).sort(),
    );
  });

  it("splits recurring task files from one-off task files", () => {
    const withoutTasks = checkedWith({ tasks: false });
    expect(withoutTasks).not.toContain("tasks/one-off/TASK.md");
    expect(withoutTasks).not.toContain("tasks/one-off/documents/spec.md");
    expect(withoutTasks).toContain("tasks/weekly-report/TASK.md");

    const withoutRoutines = checkedWith({ routines: false });
    expect(withoutRoutines).toContain("tasks/one-off/TASK.md");
    expect(withoutRoutines).toContain("tasks/one-off/documents/spec.md");
    expect(withoutRoutines).not.toContain("tasks/weekly-report/TASK.md");
  });

  it("drops a blob when its owning one-off task is excluded", () => {
    const checked = checkedWith({ tasks: false });
    expect(checked).not.toContain("blobs/aaa111");
    // Routine-owned blob still travels with its routine.
    expect(checked).toContain("blobs/bbb222");
  });

  it("drops a blob when its owning routine is excluded", () => {
    const checked = checkedWith({ routines: false });
    expect(checked).toContain("blobs/aaa111");
    expect(checked).not.toContain("blobs/bbb222");
  });

  it("excludes all blobs when attachments is off, keeping task files", () => {
    const checked = checkedWith({ attachments: false });
    expect(checked).not.toContain("blobs/aaa111");
    expect(checked).not.toContain("blobs/bbb222");
    expect(checked).toContain("tasks/one-off/TASK.md");
    expect(checked).toContain("tasks/weekly-report/TASK.md");
  });

  it("forces attachments off when both tasks and routines are off", () => {
    const checked = checkedWith({ tasks: false, routines: false, attachments: true });
    expect(checked.some((p) => p.startsWith("blobs/"))).toBe(false);
    expect(checked.some((p) => p.startsWith("tasks/"))).toBe(false);
  });

  it("always includes root files, even with every category off", () => {
    const checked = checkedWith({
      agents: false,
      projects: false,
      skills: false,
      routines: false,
      tasks: false,
      attachments: false,
    });
    expect(checked).toEqual([...ROOT_FILES].sort());
  });

  it("keeps a blob referenced by both a one-off task and a routine while either is on", () => {
    const issues: ExportSelectionIssue[] = [
      { path: "tasks/one-off/TASK.md", recurring: false, attachments: [attachment("shared")] },
      { path: "tasks/weekly-report/TASK.md", recurring: true, attachments: [attachment("shared")] },
    ];
    const filePaths = ["tasks/one-off/TASK.md", "tasks/weekly-report/TASK.md", "blobs/shared"];

    for (const overrides of [{ tasks: false }, { routines: false }] as const) {
      const checked = buildExportCheckedFiles({
        filePaths,
        issues,
        categories: selection(overrides),
      });
      expect(checked.has("blobs/shared")).toBe(true);
    }

    const bothOff = buildExportCheckedFiles({
      filePaths,
      issues,
      categories: selection({ tasks: false, routines: false }),
    });
    expect(bothOff.has("blobs/shared")).toBe(false);
  });

  it("gates unreferenced blobs on the attachments toggle alone", () => {
    const filePaths = ["tasks/one-off/TASK.md", "blobs/orphan"];
    const issues: ExportSelectionIssue[] = [
      { path: "tasks/one-off/TASK.md", recurring: false, attachments: [] },
    ];

    expect(
      buildExportCheckedFiles({ filePaths, issues, categories: selection() }).has("blobs/orphan"),
    ).toBe(true);
    expect(
      buildExportCheckedFiles({ filePaths, issues, categories: selection({ attachments: false }) }).has("blobs/orphan"),
    ).toBe(false);
    expect(
      buildExportCheckedFiles({
        filePaths,
        issues,
        categories: selection({ tasks: false, routines: false }),
      }).has("blobs/orphan"),
    ).toBe(false);
  });
});

describe("isAttachmentsCategoryEnabled", () => {
  it("is enabled while tasks or routines remain selected", () => {
    expect(isAttachmentsCategoryEnabled(selection())).toBe(true);
    expect(isAttachmentsCategoryEnabled(selection({ tasks: false }))).toBe(true);
    expect(isAttachmentsCategoryEnabled(selection({ routines: false }))).toBe(true);
    expect(isAttachmentsCategoryEnabled(selection({ tasks: false, routines: false }))).toBe(false);
  });
});

describe("countExportFilesByCategory", () => {
  it("counts files per category, leaving root files uncounted", () => {
    expect(countExportFilesByCategory(FILE_PATHS, ISSUES)).toEqual({
      agents: 2,
      projects: 1,
      skills: 1,
      routines: 1,
      tasks: 2,
      attachments: 2,
    });
  });
});
