import { describe, expect, it } from "vitest";
import {
  findWorkspaceCommandDefinition,
  listWorkspaceCommandDefinitions,
  matchWorkspaceRuntimeServiceToCommand,
  scoreWorkspaceRuntimeServiceMatch,
} from "./workspace-commands.js";

describe("workspace command helpers", () => {
  it("derives service and job commands from command-first runtime config", () => {
    const commands = listWorkspaceCommandDefinitions({
      commands: [
        { id: "web", name: "web", kind: "service", command: "pnpm dev" },
        { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
      ],
    });

    expect(commands).toEqual([
      expect.objectContaining({ id: "web", kind: "service", serviceIndex: 0 }),
      expect.objectContaining({ id: "db-migrate", kind: "job", serviceIndex: null }),
    ]);
  });

  it("falls back to legacy services and jobs arrays", () => {
    const commands = listWorkspaceCommandDefinitions({
      services: [{ name: "web", command: "pnpm dev" }],
      jobs: [{ name: "lint", command: "pnpm lint" }],
    });

    expect(commands).toEqual([
      expect.objectContaining({ id: "service:web", kind: "service", serviceIndex: 0 }),
      expect.objectContaining({ id: "job:lint", kind: "job", serviceIndex: null }),
    ]);
  });

  it("matches a configured service command to the current runtime service", () => {
    const workspaceRuntime = {
      commands: [
        { id: "web", name: "web", kind: "service", command: "pnpm dev", cwd: "." },
      ],
    };
    const command = findWorkspaceCommandDefinition(workspaceRuntime, "web");
    expect(command).not.toBeNull();

    const match = matchWorkspaceRuntimeServiceToCommand(command!, [
      {
        id: "runtime-web",
        serviceName: "web",
        command: "pnpm dev",
        cwd: "/repo",
        configIndex: null,
      },
    ]);

    expect(match).toEqual(expect.objectContaining({ id: "runtime-web" }));
  });

  it("returns null when no runtime services provided", () => {
    expect(listWorkspaceCommandDefinitions(null)).toEqual([]);
    expect(listWorkspaceCommandDefinitions(undefined)).toEqual([]);
    expect(listWorkspaceCommandDefinitions({})).toEqual([]);
  });

  it("deduplicates commands with the same derived ID using source suffix", () => {
    const commands = listWorkspaceCommandDefinitions({
      services: [
        { name: "web", command: "pnpm dev" },
        { name: "web", command: "pnpm dev:alt" },
      ],
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]!.id).not.toEqual(commands[1]!.id);
  });

  it("scores configIndex fast-path: exact match returns 100, mismatch returns -1", () => {
    const command = { serviceIndex: 1, name: "api", command: "pnpm api", cwd: null };
    expect(scoreWorkspaceRuntimeServiceMatch(command, { configIndex: 1, serviceName: "api", command: "pnpm api", cwd: null })).toBe(100);
    expect(scoreWorkspaceRuntimeServiceMatch(command, { configIndex: 0, serviceName: "api", command: "pnpm api", cwd: null })).toBe(-1);
  });

  it("scores zero returns null from matchWorkspaceRuntimeServiceToCommand", () => {
    const command = { serviceIndex: null, name: "web", command: "pnpm dev", cwd: null };
    const result = matchWorkspaceRuntimeServiceToCommand(command, [
      { id: "svc", configIndex: null, serviceName: "other", command: "other", cwd: null },
    ]);
    expect(result).toBeNull();
  });

  it("scores cwd partial match (endsWith) contribution", () => {
    const command = { serviceIndex: null, name: "web", command: null, cwd: "frontend" };
    const score = scoreWorkspaceRuntimeServiceMatch(command, {
      configIndex: null,
      serviceName: "web",
      command: null,
      cwd: "/repo/frontend",
    });
    expect(score).toBeGreaterThan(4);
  });
});
