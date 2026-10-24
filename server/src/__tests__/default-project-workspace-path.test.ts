import { describe, expect, it } from "vitest";
import { patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { resolveDefaultProjectWorkspacePath } from "../services/projects.js";

describe("resolveDefaultProjectWorkspacePath", () => {
  const project = { id: "proj-1", name: "My Project", companyId: "comp-1" };

  it("returns null when template is empty", () => {
    expect(resolveDefaultProjectWorkspacePath({ template: null, project })).toBeNull();
    expect(resolveDefaultProjectWorkspacePath({ template: "   ", project })).toBeNull();
  });

  it("requires a project placeholder", () => {
    expect(
      resolveDefaultProjectWorkspacePath({ template: "/tmp/{company_id}", project }),
    ).toBeNull();
  });

  it("renders placeholders and expands ~", () => {
    const result = resolveDefaultProjectWorkspacePath({
      template: "~/Workspaces/{project_slug}",
      project,
    });
    expect(result).not.toBeNull();
    expect(result!.endsWith("/Workspaces/my-project")).toBe(true);
    expect(result!.startsWith("/")).toBe(true);
  });

  it("rejects non-absolute and traversal paths", () => {
    expect(
      resolveDefaultProjectWorkspacePath({ template: "relative/{project_name}", project }),
    ).toBeNull();
    expect(
      resolveDefaultProjectWorkspacePath({ template: "/tmp/{project_name}/../x", project }),
    ).toBeNull();
  });

  it("sanitizes project name segments", () => {
    const result = resolveDefaultProjectWorkspacePath({
      template: "/tmp/{project_name}",
      project: { id: "p", name: "a/b\\c", companyId: "c" },
    });
    expect(result).toBe("/tmp/a-b-c");
  });

  it("rejects traversal or current-dir segments that a placeholder would introduce", () => {
    expect(
      resolveDefaultProjectWorkspacePath({
        template: "~/{project_name}",
        project: { id: "p", name: "..", companyId: "c" },
      }),
    ).toBeNull();
    expect(
      resolveDefaultProjectWorkspacePath({ template: "/tmp/{project_name}", project: { id: "p", name: "..", companyId: "c" } }),
    ).toBeNull();
    expect(
      resolveDefaultProjectWorkspacePath({ template: "~/{project_name}", project: { id: "p", name: ".", companyId: "c" } }),
    ).toBeNull();
  });

  it("renders repo_name when provided", () => {
    const result = resolveDefaultProjectWorkspacePath({
      template: "/tmp/{project_name}/{repo_name}",
      project,
      repoUrl: "https://github.com/org/my-repo.git",
    });
    expect(result).toBe("/tmp/My Project/my-repo");
  });
});

describe("default project folder template validation", () => {
  it("rejects relative paths and traversal segments at save time", () => {
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: "relative/{project_name}" }).success,
    ).toBe(false);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: "/tmp/{project_name}/../other" }).success,
    ).toBe(false);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: "/tmp/./{project_name}" }).success,
    ).toBe(false);
  });

  it("accepts absolute and home-relative templates, and null to clear", () => {
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: "/tmp/{project_name}" }).success,
    ).toBe(true);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: "~/work/{project_slug}" }).success,
    ).toBe(true);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: null }).success,
    ).toBe(true);
  });

  it("still requires a project placeholder", () => {
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ defaultProjectWorkspacePathTemplate: "/tmp/{company_id}" }).success,
    ).toBe(false);
  });
});
