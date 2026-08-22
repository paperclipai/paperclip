import { describe, expect, it } from "vitest";
import {
  findWorkspaceCommandDefinition,
  listWorkspaceCommandDefinitions,
  matchWorkspaceRuntimeServiceToCommand,
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

  it("does not match a stale runtime service after the configured command changes", () => {
    const workspaceRuntime = {
      commands: [
        { id: "web", name: "web", kind: "service", command: "pnpm dev:once --tailscale-auth", cwd: "." },
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

    expect(match).toBeNull();
  });

  it("matches an exposed dev runtime whose bind command was hardened to loopback", () => {
    const workspaceRuntime = {
      commands: [
        { id: "web", name: "paperclip-dev", kind: "service", command: "pnpm dev --bind lan" },
      ],
    };
    const command = findWorkspaceCommandDefinition(workspaceRuntime, "web");
    expect(command).not.toBeNull();

    const match = matchWorkspaceRuntimeServiceToCommand(command!, [
      {
        id: "runtime-web",
        serviceName: "paperclip-dev",
        command: "pnpm dev --bind loopback",
        cwd: "/repo",
        configIndex: null,
        exposure: {
          provider: "tailscale_https",
          state: "ready",
          publicUrl: "https://paperclip-dev.example.ts.net:42012",
          hostname: "paperclip-dev.example.ts.net",
          listeners: [],
          brokerRef: "broker-1",
          lastError: null,
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ]);

    expect(match).toEqual(expect.objectContaining({ id: "runtime-web" }));
  });

  it("does not equate a loopback command with a lan command without managed exposure", () => {
    const command = findWorkspaceCommandDefinition({
      services: [{ name: "paperclip-dev", command: "pnpm dev --bind lan" }],
    }, "service:paperclip-dev");

    const match = matchWorkspaceRuntimeServiceToCommand(command!, [
      {
        id: "runtime-web",
        serviceName: "paperclip-dev",
        command: "pnpm dev --bind loopback",
        cwd: "/repo",
        configIndex: null,
        exposure: null,
      },
    ]);

    expect(match).toBeNull();
  });
});
