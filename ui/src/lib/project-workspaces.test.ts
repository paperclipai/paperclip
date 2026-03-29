import { describe, expect, it } from "vitest";
import {
  defaultProjectWorkspaceIdForProject,
  projectWorkspaceLocation,
  projectWorkspaceLocationLabel,
  projectWorkspaceOptionLabel,
  selectedProjectWorkspaceForProject,
} from "./project-workspaces";

describe("project workspace helpers", () => {
  const primaryWorkspace = {
    id: "workspace-primary",
    name: "Paperclip",
    isPrimary: true,
    repoUrl: "https://github.com/ryjm/paperclip",
    cwd: "/repo/paperclip",
  };
  const secondaryWorkspace = {
    id: "workspace-secondary",
    name: "Tabula",
    isPrimary: false,
    repoUrl: "https://github.com/ryjm/tabula",
    cwd: "/repo/tabula",
  };

  it("defaults to the execution workspace policy workspace when present", () => {
    expect(
      defaultProjectWorkspaceIdForProject({
        executionWorkspacePolicy: { defaultProjectWorkspaceId: secondaryWorkspace.id },
        primaryWorkspace,
        workspaces: [primaryWorkspace, secondaryWorkspace],
      }),
    ).toBe(secondaryWorkspace.id);
  });

  it("falls back to the primary workspace when no policy default is set", () => {
    expect(
      defaultProjectWorkspaceIdForProject({
        executionWorkspacePolicy: null,
        primaryWorkspace,
        workspaces: [primaryWorkspace, secondaryWorkspace],
      }),
    ).toBe(primaryWorkspace.id);
  });

  it("resolves the explicitly selected project workspace before launch", () => {
    expect(
      selectedProjectWorkspaceForProject(
        {
          primaryWorkspace,
          workspaces: [primaryWorkspace, secondaryWorkspace],
        },
        secondaryWorkspace.id,
      ),
    ).toEqual(secondaryWorkspace);
  });

  it("falls back to the primary workspace when the selected id is missing", () => {
    expect(
      selectedProjectWorkspaceForProject(
        {
          primaryWorkspace,
          workspaces: [primaryWorkspace, secondaryWorkspace],
        },
        "missing-workspace",
      ),
    ).toEqual(primaryWorkspace);
  });

  it("formats repo-backed and path-backed workspace summaries", () => {
    expect(projectWorkspaceLocation(primaryWorkspace)).toBe(primaryWorkspace.repoUrl);
    expect(projectWorkspaceLocationLabel(primaryWorkspace)).toBe("Repo");
    expect(projectWorkspaceOptionLabel(primaryWorkspace)).toContain("primary");

    const localOnlyWorkspace = {
      id: "workspace-local",
      name: "Scratch",
      isPrimary: false,
      repoUrl: null,
      cwd: "/tmp/scratch",
    };
    expect(projectWorkspaceLocation(localOnlyWorkspace)).toBe(localOnlyWorkspace.cwd);
    expect(projectWorkspaceLocationLabel(localOnlyWorkspace)).toBe("Path");
  });
});
