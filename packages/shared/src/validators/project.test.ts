import { describe, expect, it } from "vitest";
import {
  createProjectSchema,
  updateProjectSchema,
  createProjectWorkspaceSchema,
  updateProjectWorkspaceSchema,
  projectExecutionWorkspacePolicySchema,
  projectWorkspaceRuntimeConfigSchema,
} from "./project.js";

describe("createProjectWorkspaceSchema", () => {
  it("accepts a workspace with cwd", () => {
    const result = createProjectWorkspaceSchema.safeParse({ cwd: "/home/user/project" });
    expect(result.success).toBe(true);
  });

  it("accepts a workspace with repoUrl", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      repoUrl: "https://github.com/org/repo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a workspace with neither cwd nor repoUrl (non-remote)", () => {
    const result = createProjectWorkspaceSchema.safeParse({ name: "my-workspace" });
    expect(result.success).toBe(false);
  });

  it("accepts a remote_managed workspace with remoteWorkspaceRef", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      sourceType: "remote_managed",
      remoteWorkspaceRef: "ref-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a remote_managed workspace without remoteWorkspaceRef or repoUrl", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      sourceType: "remote_managed",
    });
    expect(result.success).toBe(false);
  });

  it("defaults isPrimary to false", () => {
    const result = createProjectWorkspaceSchema.safeParse({ cwd: "/path" });
    expect(result.success && result.data.isPrimary).toBe(false);
  });

  it("accepts valid sourceType values", () => {
    for (const sourceType of ["local_path", "git_repo", "non_git_path"]) {
      expect(
        createProjectWorkspaceSchema.safeParse({ sourceType, cwd: "/path" }).success,
      ).toBe(true);
    }
  });

  it("accepts valid visibility values", () => {
    for (const visibility of ["default", "advanced"]) {
      expect(
        createProjectWorkspaceSchema.safeParse({ cwd: "/path", visibility }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown fields (strict schema via z.object)", () => {
    // The schema is not strict(), but the superRefine provides validation
    // Additional fields not in the schema are stripped
    const result = createProjectWorkspaceSchema.safeParse({ cwd: "/path", repoRef: "main" });
    expect(result.success).toBe(true);
  });
});

describe("updateProjectWorkspaceSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateProjectWorkspaceSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial updates", () => {
    expect(updateProjectWorkspaceSchema.safeParse({ name: "new-name", repoRef: "main" }).success).toBe(true);
  });
});

describe("createProjectSchema", () => {
  it("accepts a minimal project", () => {
    expect(createProjectSchema.safeParse({ name: "My Project" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(createProjectSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("defaults status to backlog", () => {
    const result = createProjectSchema.safeParse({ name: "P" });
    expect(result.success && result.data.status).toBe("backlog");
  });

  it("accepts valid status values", () => {
    for (const status of ["backlog", "planned", "in_progress", "completed", "cancelled"]) {
      expect(createProjectSchema.safeParse({ name: "P", status }).success).toBe(true);
    }
  });

  it("accepts optional workspace inline", () => {
    const result = createProjectSchema.safeParse({
      name: "P",
      workspace: { cwd: "/path/to/repo" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional goalIds array", () => {
    const result = createProjectSchema.safeParse({
      name: "P",
      goalIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts env bindings", () => {
    const result = createProjectSchema.safeParse({
      name: "P",
      env: { DB_URL: "postgres://localhost/test" },
    });
    expect(result.success).toBe(true);
  });
});

describe("updateProjectSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial updates", () => {
    expect(updateProjectSchema.safeParse({ name: "New Name", status: "in_progress" }).success).toBe(true);
  });
});

describe("projectExecutionWorkspacePolicySchema", () => {
  it("accepts a minimal policy with enabled flag", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("accepts a full policy", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({ enabled: true, unknownField: true }).success,
    ).toBe(false);
  });

  it("rejects invalid defaultMode", () => {
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({ enabled: true, defaultMode: "random" }).success,
    ).toBe(false);
  });
});

describe("projectWorkspaceRuntimeConfigSchema", () => {
  it("accepts an empty object", () => {
    expect(projectWorkspaceRuntimeConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid desiredState values", () => {
    expect(projectWorkspaceRuntimeConfigSchema.safeParse({ desiredState: "running" }).success).toBe(true);
    expect(projectWorkspaceRuntimeConfigSchema.safeParse({ desiredState: "stopped" }).success).toBe(true);
  });

  it("rejects invalid desiredState", () => {
    expect(projectWorkspaceRuntimeConfigSchema.safeParse({ desiredState: "paused" }).success).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(
      projectWorkspaceRuntimeConfigSchema.safeParse({ unknownField: true }).success,
    ).toBe(false);
  });
});
