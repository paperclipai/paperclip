import { describe, expect, it } from "vitest";
import {
  collectExecutionWorkspaceCommandPaths,
  collectIssueWorkspaceCommandPaths,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "../routes/workspace-command-authz.js";

describe("workspace host-command mutation detection", () => {
  it.each([
    {
      name: "project execution policy commands",
      actual: () => collectProjectExecutionWorkspaceCommandPaths({
        workspaceRuntime: { commands: [{ name: "seed", command: "pnpm seed" }] },
      }),
      expected: "executionWorkspacePolicy.workspaceRuntime.commands[0].command",
    },
    {
      name: "project execution policy services",
      actual: () => collectProjectExecutionWorkspaceCommandPaths({
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
      }),
      expected: "executionWorkspacePolicy.workspaceRuntime.services[0].command",
    },
    {
      name: "project workspace jobs",
      actual: () => collectProjectWorkspaceCommandPaths({
        runtimeConfig: { workspaceRuntime: { jobs: [{ name: "build", command: "pnpm build" }] } },
      }),
      expected: "runtimeConfig.workspaceRuntime.jobs[0].command",
    },
    {
      name: "issue execution workspace services",
      actual: () => collectIssueWorkspaceCommandPaths({
        executionWorkspaceSettings: {
          workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        },
      }),
      expected: "executionWorkspaceSettings.workspaceRuntime.services[0].command",
    },
    {
      name: "execution workspace config commands",
      actual: () => collectExecutionWorkspaceCommandPaths({
        config: { workspaceRuntime: { commands: [{ name: "seed", command: "pnpm seed" }] } },
      }),
      expected: "config.workspaceRuntime.commands[0].command",
    },
    {
      name: "execution workspace metadata jobs",
      actual: () => collectExecutionWorkspaceCommandPaths({
        metadata: {
          config: { workspaceRuntime: { jobs: [{ name: "build", command: "pnpm build" }] } },
        },
      }),
      expected: "metadata.config.workspaceRuntime.jobs[0].command",
    },
  ])("detects $name", ({ actual, expected }) => {
    expect(actual()).toContain(expected);
  });

  it("ignores descriptive runtime entries without a command field", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths({
      workspaceRuntime: {
        commands: [{ name: "seed" }],
        services: [{ name: "web", port: 3100 }],
        jobs: [null, "build"],
      },
    })).toEqual([]);
  });

  it.each([
    "command",
    "hermesCommand",
    "args",
    "extraArgs",
    "cwd",
    "env",
    "filesystemSandboxCommand",
    "skillsRootPath",
  ])("collects task override adapterConfig.%s as a host-command path", (key) => {
    expect(collectIssueWorkspaceCommandPaths({
      assigneeAdapterOverrides: { adapterConfig: { [key]: key === "env" ? {} : "value" } },
    })).toContain(`assigneeAdapterOverrides.adapterConfig.${key}`);
  });

  it("ignores benign task override adapterConfig keys", () => {
    expect(collectIssueWorkspaceCommandPaths({
      assigneeAdapterOverrides: { adapterConfig: { model: "gpt-5.6-sol", temperature: 0.2 } },
    })).toEqual([]);
  });
});
