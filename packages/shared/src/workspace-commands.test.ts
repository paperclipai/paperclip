import { describe, expect, it } from "vitest";
import {
  findWorkspaceCommandDefinition,
  listWorkspaceCommandDefinitions,
  matchWorkspaceRuntimeServiceToCommand,
  countRuntimeServicesActiveAfterStop,
  resolveRuntimeServiceStopTarget,
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
        port: null,
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
        port: null,
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

  it("does not revive runtime history from a previously configured port", () => {
    const command = findWorkspaceCommandDefinition({
      services: [
        {
          name: "web",
          command: "pnpm dev",
          port: { type: "fixed", value: 42001 },
        },
      ],
    }, "service:web");
    expect(command).toEqual(expect.objectContaining({ port: 42001 }));

    const match = matchWorkspaceRuntimeServiceToCommand(command!, [
      {
        id: "runtime-old-port",
        serviceName: "web",
        command: "pnpm dev",
        cwd: "/repo",
        port: 42013,
        configIndex: 0,
      },
      {
        id: "runtime-current-port",
        serviceName: "web",
        command: "pnpm dev",
        cwd: "/repo",
        port: 42001,
        configIndex: 0,
      },
    ]);

    expect(match).toEqual(expect.objectContaining({ id: "runtime-current-port" }));
  });

  it("does not treat an auto port preference as a fixed runtime identity", () => {
    const command = findWorkspaceCommandDefinition({
      services: [
        {
          name: "web",
          command: "pnpm dev",
          port: { type: "auto", value: 42001 },
        },
      ],
    }, "service:web");

    expect(command).toEqual(expect.objectContaining({ port: null }));
  });
});

describe("resolveRuntimeServiceStopTarget", () => {
  const workspaceRuntime = {
    services: [
      { name: "web", command: "pnpm dev" },
      { name: "worker", command: "pnpm worker" },
    ],
  };
  const runtimeServices = [
    { id: "runtime-web", serviceName: "web", command: "pnpm dev", cwd: "/repo", port: null, configIndex: 0 },
    { id: "runtime-worker", serviceName: "worker", command: "pnpm worker", cwd: "/repo", port: null, configIndex: 1 },
  ];

  it("stops every service when the request names no target", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime,
      runtimeServiceId: null,
      serviceIndex: null,
      runtimeServices,
    })).toEqual({ scope: "all" });
  });

  it("stops only the named runtime service", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime,
      runtimeServiceId: "runtime-worker",
      serviceIndex: null,
      runtimeServices,
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-worker" });
  });

  it("stops only the running instance of the service at the given index", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime,
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices,
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-worker" });
  });

  it("stops nothing when the service at the given index is not running", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime,
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices: [runtimeServices[0]!],
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });

  it("does not stop another service that only shares the command", () => {
    const sharedCommandRuntime = {
      services: [
        { name: "api", command: "node server.js", cwd: "api" },
        { name: "admin", command: "node server.js", cwd: "admin" },
      ],
    };

    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedCommandRuntime,
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices: [
        { id: "runtime-api", serviceName: "api", command: "node server.js", cwd: "/repo/api", port: null },
      ],
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });

  it("stops an unnamed service by the name the start path gives it", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: { services: [{ command: "pnpm dev" }] },
      runtimeServiceId: null,
      serviceIndex: 0,
      runtimeServices: [
        { id: "runtime-dev", serviceName: "service", command: "pnpm dev", cwd: "/repo", port: null },
      ],
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-dev" });
  });

  it("does not stop an unnamed service in a subfolder for an unnamed service at the workspace root", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: {
        services: [
          { command: "node server.js", cwd: "api" },
          { command: "node server.js" },
        ],
      },
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices: [
        { id: "runtime-api", serviceName: "service", command: "node server.js", cwd: "/repo/api", port: null },
      ],
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });

  it("stops an unnamed service whose configured cwd resolves to its running folder", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: { services: [{ command: "node server.js", cwd: "./api/" }] },
      runtimeServiceId: null,
      serviceIndex: 0,
      runtimeServices: [
        { id: "runtime-api", serviceName: "service", command: "node server.js", cwd: "/repo/api", port: null },
      ],
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-api" });
  });

  it("does not stop another unnamed service that runs in a different cwd", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: {
        services: [
          { command: "node server.js", cwd: "api" },
          { command: "node server.js", cwd: "admin" },
        ],
      },
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices: [
        { id: "runtime-api", serviceName: "service", command: "node server.js", cwd: "/repo/api", port: null },
      ],
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });

  it("stops nothing when another service with the same name could have started the instance", () => {
    for (const serviceIndex of [0, 1]) {
      expect(resolveRuntimeServiceStopTarget({
        workspaceRuntime: {
          services: [
            { name: "web", command: "pnpm dev", cwd: "site", env: { MODE: "a" } },
            { name: "web", command: "pnpm dev", cwd: "site", env: { MODE: "b" } },
          ],
        },
        runtimeServiceId: null,
        serviceIndex,
        runtimeServices: [
          { id: "runtime-site", serviceName: "web", command: "pnpm dev", cwd: "/repo/site", port: null },
        ],
        workspaceCwd: "/repo",
      })).toEqual({ scope: "one", runtimeServiceId: null });
    }
  });

  it("stops a lone unnamed service without needing the workspace cwd", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }, { command: "pnpm worker" }] },
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices: [
        { id: "runtime-worker", serviceName: "service", command: "pnpm worker", cwd: "/repo", port: null },
      ],
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-worker" });
  });

  it("does not stop a service whose name only equals another service's fallback label", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: {
        services: [
          { name: "Service 2", command: "node server.js" },
          { command: "node server.js" },
        ],
      },
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices: [
        { id: "runtime-named", serviceName: "Service 2", command: "node server.js", cwd: "/repo", port: null },
      ],
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });

  it("tells apart services that share an explicit name by their cwd", () => {
    const sharedNameRuntime = {
      services: [
        { name: "web", command: "pnpm dev", cwd: "site" },
        { name: "web", command: "pnpm dev", cwd: "docs" },
      ],
    };
    const runtimeServices = [
      { id: "runtime-site", serviceName: "web", command: "pnpm dev", cwd: "/repo/site", port: null },
    ];

    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedNameRuntime,
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices,
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: null });
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedNameRuntime,
      runtimeServiceId: null,
      serviceIndex: 0,
      runtimeServices,
      workspaceCwd: "/repo",
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-site" });
  });

  it("compares cwds with the caller's resolver when one is given", () => {
    const sharedNameRuntime = {
      services: [
        { name: "web", command: "pnpm dev", cwd: "~/site" },
        { name: "web", command: "pnpm dev", cwd: "~/docs" },
      ],
    };
    const runtimeServices = [
      { id: "runtime-site", serviceName: "web", command: "pnpm dev", cwd: "/home/dev/site", port: null },
    ];
    const resolveServiceCwd = (command: { cwd: string | null }) => command.cwd?.replace("~", "/home/dev") ?? null;

    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedNameRuntime,
      runtimeServiceId: null,
      serviceIndex: 0,
      runtimeServices,
      resolveServiceCwd,
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-site" });
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedNameRuntime,
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices,
      resolveServiceCwd,
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });

  it("does not trust an inferred config index that names another service", () => {
    // Read models infer configIndex with a matcher that accepts a shared
    // command, so the running `admin` instance can carry the index of `api`.
    const sharedCommandRuntime = {
      services: [
        { name: "api", command: "node server.js" },
        { name: "admin", command: "node server.js" },
      ],
    };
    const runtimeServices = [
      { id: "runtime-admin", serviceName: "admin", command: "node server.js", cwd: "/repo", port: null, configIndex: 0 },
    ];

    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedCommandRuntime,
      runtimeServiceId: null,
      serviceIndex: 0,
      runtimeServices,
    })).toEqual({ scope: "one", runtimeServiceId: null });
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime: sharedCommandRuntime,
      runtimeServiceId: null,
      serviceIndex: 1,
      runtimeServices,
    })).toEqual({ scope: "one", runtimeServiceId: "runtime-admin" });
  });

  it("stops nothing when the given index has no configured service", () => {
    expect(resolveRuntimeServiceStopTarget({
      workspaceRuntime,
      runtimeServiceId: null,
      serviceIndex: 5,
      runtimeServices,
    })).toEqual({ scope: "one", runtimeServiceId: null });
  });
});

describe("countRuntimeServicesActiveAfterStop", () => {
  const runtimeServices = [
    { id: "runtime-web", status: "running" },
    { id: "runtime-worker", status: "stopped" },
    { id: "runtime-docs", status: "starting" },
    { id: "runtime-old", status: "failed" },
  ];

  it("counts nothing after every service is stopped", () => {
    expect(countRuntimeServicesActiveAfterStop(runtimeServices, { scope: "all" })).toBe(0);
  });

  it("counts the active services other than the stopped one", () => {
    expect(countRuntimeServicesActiveAfterStop(runtimeServices, { scope: "one", runtimeServiceId: "runtime-web" })).toBe(1);
  });

  it("counts every active service when nothing was stopped", () => {
    expect(countRuntimeServicesActiveAfterStop(runtimeServices, { scope: "one", runtimeServiceId: null })).toBe(2);
  });
});
