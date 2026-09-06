import { describe, expect, it } from "vitest";
import {
  matchProjectIdByRepoReference,
  normalizeRepoIdentity,
  resolveExplicitProjectSelection,
} from "../services/issue-project-inference.ts";

describe("normalizeRepoIdentity", () => {
  it("folds every remote form of the same repo onto one identity", () => {
    const expected = "github.com/zannis/paperclip";
    expect(normalizeRepoIdentity("https://github.com/zannis/paperclip")).toBe(expected);
    expect(normalizeRepoIdentity("https://github.com/zannis/paperclip.git")).toBe(expected);
    expect(normalizeRepoIdentity("https://github.com/zannis/paperclip/")).toBe(expected);
    expect(normalizeRepoIdentity("http://github.com/Zannis/Paperclip")).toBe(expected);
    expect(normalizeRepoIdentity("git@github.com:zannis/paperclip.git")).toBe(expected);
    expect(normalizeRepoIdentity("ssh://git@github.com/zannis/paperclip.git")).toBe(expected);
    expect(normalizeRepoIdentity("https://user:token@github.com/zannis/paperclip")).toBe(expected);
    expect(normalizeRepoIdentity("https://www.github.com/zannis/paperclip")).toBe(expected);
  });

  it("keeps non-GitHub hosts distinct", () => {
    expect(normalizeRepoIdentity("https://gitlab.com/zannis/paperclip")).toBe(
      "gitlab.com/zannis/paperclip",
    );
  });

  it("ignores the port so one repo folds together across transports", () => {
    // A self-hosted repo is commonly https on the default port and ssh on a
    // custom one. Those are the same repo and must match each other.
    const expected = "git.example.com/team/service";
    expect(normalizeRepoIdentity("https://git.example.com/team/service")).toBe(expected);
    expect(normalizeRepoIdentity("https://git.example.com:8443/team/service")).toBe(expected);
    expect(normalizeRepoIdentity("ssh://git@git.example.com:2222/team/service.git")).toBe(expected);
  });

  it("rejects anything that is not an owner/repo remote", () => {
    expect(normalizeRepoIdentity("")).toBeNull();
    expect(normalizeRepoIdentity("   ")).toBeNull();
    expect(normalizeRepoIdentity("https://github.com/zannis")).toBeNull();
    expect(normalizeRepoIdentity("not a url")).toBeNull();
    expect(normalizeRepoIdentity("/paperclip/agents/repos/actual")).toBeNull();
  });
});

describe("matchProjectIdByRepoReference", () => {
  const workspaces = [
    { projectId: "project-actual", repoUrl: "https://github.com/zannis/actual", cwd: "/paperclip/agents/repos/actual" },
    { projectId: "project-shove", repoUrl: "https://github.com/zannis/shove", cwd: "/paperclip/agents/repos/shove" },
    { projectId: "project-paperclip", repoUrl: "git@github.com:zannis/paperclip.git", cwd: null },
    { projectId: "project-no-repo", repoUrl: null, cwd: null },
  ];

  it("returns null when nothing in the text names a repo", () => {
    expect(
      matchProjectIdByRepoReference({ text: "Tidy up the onboarding copy", workspaces }),
    ).toBeNull();
  });

  it("matches a remote URL against a workspace repoUrl", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "The regression is in https://github.com/zannis/shove/blob/main/src/main.rs",
        workspaces,
      }),
    ).toBe("project-shove");
  });

  it("matches across differing remote forms", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Clone git@github.com:zannis/paperclip.git and reproduce",
        workspaces,
      }),
    ).toBe("project-paperclip");
  });

  it("matches a repo nested deeper than the shallow-prefix scan", () => {
    // A GitLab subgroup path can run past the depth a `/blob/main/...` URL needs.
    // The workspace identity keeps every segment, so the text scan has to be able
    // to reach the same depth or a description naming the repo exactly never matches.
    const deep = [
      { projectId: "project-deep", repoUrl: "https://gitlab.example.com/org/div/team/squad/svc/api.git", cwd: null },
    ];
    expect(
      matchProjectIdByRepoReference({
        text: "Ships from https://gitlab.example.com/org/div/team/squad/svc/api",
        workspaces: deep,
      }),
    ).toBe("project-deep");
  });

  it("does not let a deep workspace repo match a shorter prefix of its path", () => {
    // Reaching deeper must not also match upward: `org/div` is a group, not the repo.
    const deep = [
      { projectId: "project-deep", repoUrl: "https://gitlab.example.com/org/div/team/squad/svc/api.git", cwd: null },
    ];
    expect(
      matchProjectIdByRepoReference({
        text: "Ships from https://gitlab.example.com/org/div",
        workspaces: deep,
      }),
    ).toBeNull();
  });

  it("matches an absolute path that is the workspace cwd", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Uncommitted work is stranded in /paperclip/agents/repos/actual",
        workspaces,
      }),
    ).toBe("project-actual");
  });

  it("matches an absolute path underneath the workspace cwd", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "See `/paperclip/agents/repos/actual/packages/loot-core/src/index.ts` for the call site.",
        workspaces,
      }),
    ).toBe("project-actual");
  });

  it("does not match a path that only shares a prefix with the cwd", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "The stray checkout at /paperclip/agents/repos/actual-backup is unrelated",
        workspaces,
      }),
    ).toBeNull();
  });

  it("prefers the most specific cwd when workspaces nest", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Broken file: /repos/mono/packages/api/src/app.ts",
        workspaces: [
          { projectId: "project-mono", repoUrl: null, cwd: "/repos/mono" },
          { projectId: "project-api", repoUrl: null, cwd: "/repos/mono/packages/api" },
        ],
      }),
    ).toBe("project-api");
  });

  it("returns null when two different projects are referenced", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Port the fix from https://github.com/zannis/shove into /paperclip/agents/repos/actual",
        workspaces,
      }),
    ).toBeNull();
  });

  it("stays on one project when several of its own workspaces are referenced", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "https://github.com/zannis/actual and /paperclip/agents/repos/actual are the same repo",
        workspaces,
      }),
    ).toBe("project-actual");
  });

  it("ignores workspaces that carry neither a repo nor a cwd", () => {
    expect(
      matchProjectIdByRepoReference({ text: "project-no-repo", workspaces }),
    ).toBeNull();
  });

  it("reports two projects that collide on one port-less identity as ambiguous", () => {
    // The flip side of folding ports away: two distinct repos on one host at
    // one path, separated only by port, become indistinguishable. That is
    // reported as ambiguous and yields no project — never the wrong one.
    expect(
      matchProjectIdByRepoReference({
        text: "Broken by https://git.example.com:8443/team/service",
        workspaces: [
          { projectId: "project-a", repoUrl: "https://git.example.com:8443/team/service", cwd: null },
          { projectId: "project-b", repoUrl: "https://git.example.com:9443/team/service", cwd: null },
        ],
      }),
    ).toBeNull();
  });

  it("does not treat a bare project name as a repo reference", () => {
    expect(
      matchProjectIdByRepoReference({ text: "shove needs a security review", workspaces }),
    ).toBeNull();
  });

  it("tolerates markdown punctuation around the reference", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Fixed in [#120](https://github.com/zannis/shove/pull/120).",
        workspaces,
      }),
    ).toBe("project-shove");
  });

  it("resolves a cwd shared by two projects to null, like a duplicate remote", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "The flake is under /repos/shared/src/index.ts.",
        workspaces: [
          { projectId: "project-a", repoUrl: null, cwd: "/repos/shared" },
          { projectId: "project-b", repoUrl: null, cwd: "/repos/shared" },
        ],
      }),
    ).toBeNull();
  });

  it("still resolves duplicate cwd rows that belong to one project", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "The flake is under /repos/shared/src/index.ts.",
        workspaces: [
          { projectId: "project-a", repoUrl: null, cwd: "/repos/shared" },
          { projectId: "project-a", repoUrl: null, cwd: "/repos/shared" },
        ],
      }),
    ).toBe("project-a");
  });

  it("keeps most-specific-wins, but a tie at that depth is ambiguous", () => {
    const nested = [
      { projectId: "project-host", repoUrl: null, cwd: "/repos/host" },
      { projectId: "project-lib", repoUrl: null, cwd: "/repos/host/vendored/lib" },
    ];
    expect(
      matchProjectIdByRepoReference({
        text: "The change is in /repos/host/vendored/lib/util.ts only.",
        workspaces: nested,
      }),
    ).toBe("project-lib");
    expect(
      matchProjectIdByRepoReference({
        text: "The change is in /repos/host/vendored/lib/util.ts only.",
        workspaces: [...nested, { projectId: "project-lib2", repoUrl: null, cwd: "/repos/host/vendored/lib" }],
      }),
    ).toBeNull();
  });
});

describe("resolveExplicitProjectSelection", () => {
  function recordingLookups(map: {
    issue?: Record<string, string | null>;
    projectWorkspace?: Record<string, string | null>;
    executionWorkspace?: Record<string, string | null>;
  }) {
    const calls: Array<[string, string]> = [];
    return {
      calls,
      lookups: {
        getIssueProjectId: async (issueId: string) => {
          calls.push(["issue", issueId]);
          return map.issue?.[issueId] ?? null;
        },
        getProjectWorkspaceProjectId: async (projectWorkspaceId: string) => {
          calls.push(["projectWorkspace", projectWorkspaceId]);
          return map.projectWorkspace?.[projectWorkspaceId] ?? null;
        },
        getExecutionWorkspaceProjectId: async (executionWorkspaceId: string) => {
          calls.push(["executionWorkspace", executionWorkspaceId]);
          return map.executionWorkspace?.[executionWorkspaceId] ?? null;
        },
      },
    };
  }

  it("answers null without lookups when no signal is present", async () => {
    const { calls, lookups } = recordingLookups({});
    expect(await resolveExplicitProjectSelection({}, lookups)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("treats null-valued fields as absent, matching the old presence gate", async () => {
    const { calls, lookups } = recordingLookups({});
    expect(
      await resolveExplicitProjectSelection(
        {
          projectId: null,
          parentId: null,
          inheritExecutionWorkspaceFromIssueId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
        },
        lookups,
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns an explicit projectId without consulting anything", async () => {
    const { calls, lookups } = recordingLookups({ issue: { "issue-1": "project-b" } });
    expect(
      await resolveExplicitProjectSelection({ projectId: "project-a", parentId: "issue-1" }, lookups),
    ).toBe("project-a");
    expect(calls).toEqual([]);
  });

  it("resolves a parent that has a project", async () => {
    const { lookups } = recordingLookups({ issue: { "issue-1": "project-b" } });
    expect(await resolveExplicitProjectSelection({ parentId: "issue-1" }, lookups)).toBe("project-b");
  });

  it("answers null for a project-less parent so inference can run", async () => {
    const { lookups } = recordingLookups({ issue: {} });
    expect(await resolveExplicitProjectSelection({ parentId: "issue-orphan" }, lookups)).toBeNull();
  });

  it("consults one source issue: a project-less inherit source is not rescued by the parent", async () => {
    // Mirrors the service, which reads inheritExecutionWorkspaceFromIssueId ??
    // parentId and never falls back to the parent when the inherit source has
    // no project. Answering the parent's project here would skip inference
    // while the service still applies nothing.
    const { calls, lookups } = recordingLookups({ issue: { "issue-1": "project-b" } });
    expect(
      await resolveExplicitProjectSelection(
        { parentId: "issue-1", inheritExecutionWorkspaceFromIssueId: "issue-orphan" },
        lookups,
      ),
    ).toBeNull();
    expect(calls).toEqual([["issue", "issue-orphan"]]);
  });

  it("resolves an inherit source that has a project", async () => {
    const { calls, lookups } = recordingLookups({ issue: { "issue-2": "project-d" } });
    expect(
      await resolveExplicitProjectSelection(
        { parentId: "issue-1", inheritExecutionWorkspaceFromIssueId: "issue-2" },
        lookups,
      ),
    ).toBe("project-d");
    expect(calls).toEqual([["issue", "issue-2"]]);
  });

  it("falls through a project-less source to a workspace that resolves", async () => {
    const { lookups } = recordingLookups({ projectWorkspace: { "pw-1": "project-c" } });
    expect(
      await resolveExplicitProjectSelection({ parentId: "issue-orphan", projectWorkspaceId: "pw-1" }, lookups),
    ).toBe("project-c");
  });

  it("resolves an execution workspace's project", async () => {
    const { lookups } = recordingLookups({ executionWorkspace: { "ew-1": "project-e" } });
    expect(await resolveExplicitProjectSelection({ executionWorkspaceId: "ew-1" }, lookups)).toBe("project-e");
  });

  it("only looks up fields that are present", async () => {
    const { calls, lookups } = recordingLookups({});
    await resolveExplicitProjectSelection({ parentId: "issue-orphan" }, lookups);
    expect(calls).toEqual([["issue", "issue-orphan"]]);
  });
});
