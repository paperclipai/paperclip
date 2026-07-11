import { describe, expect, it } from "vitest";
import {
  getConfiguredRuntimeServicePortWarnings,
  readConfiguredRuntimeServicePorts,
  updateConfiguredRuntimeServicePort,
} from "./ExecutionWorkspaceDetail";

describe("execution workspace service port configuration", () => {
  it("reads commands and legacy services, then saves a fixed port without mutating the source config", () => {
    const runtimeConfig = {
      commands: [
        { id: "web", name: "Web app", kind: "service", command: "pnpm dev", port: { type: "auto" } },
        { id: "migrate", name: "Migrate", kind: "job", command: "pnpm db:migrate" },
      ],
      services: [{ name: "Legacy", command: "pnpm legacy", port: 3100 }],
    };

    const services = readConfiguredRuntimeServicePorts(runtimeConfig);
    expect(services).toEqual([
      { collection: "commands", index: 0, name: "Web app", port: null },
      { collection: "services", index: 0, name: "Legacy", port: 3100 },
    ]);

    expect(updateConfiguredRuntimeServicePort({
      runtimeConfig,
      service: services[0]!,
      port: "4200",
    })).toEqual({
      commands: [
        { id: "web", name: "Web app", kind: "service", command: "pnpm dev", port: { type: "fixed", value: 4200 } },
        { id: "migrate", name: "Migrate", kind: "job", command: "pnpm db:migrate" },
      ],
      services: [{ name: "Legacy", command: "pnpm legacy", port: 3100 }],
    });
    expect(runtimeConfig.commands[0]?.port).toEqual({ type: "auto" });
  });

  it("warns when fixed ports collide in the same workspace configuration", () => {
    expect(getConfiguredRuntimeServicePortWarnings([
      { collection: "commands", index: 0, name: "Web", port: 3100 },
      { collection: "commands", index: 1, name: "Admin", port: 3100 },
      { collection: "services", index: 0, name: "Worker", port: 3200 },
    ])).toEqual(["Port 3100 is assigned to multiple services: Web, Admin."]);
  });
});
