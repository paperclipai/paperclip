import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  type HostServices,
} from "../src/host-client-factory.js";

function stubServices(overrides: Partial<HostServices> = {}): HostServices {
  const noop = async () => {
    throw new Error("not stubbed");
  };
  const base = {
    config: { get: noop },
    state: { get: noop, set: noop, delete: noop, list: noop },
    entities: { upsert: noop, list: noop },
    events: { emit: noop, subscribe: noop },
    http: { fetch: noop },
    secrets: { resolve: noop },
    activity: { log: noop },
    metrics: { write: noop },
    telemetry: { track: noop },
    companies: { list: noop, get: noop },
    projects: {
      list: noop,
      get: noop,
      listWorkspaces: noop,
      getPrimaryWorkspace: noop,
      getWorkspaceForIssue: noop,
    },
    issues: {
      list: noop,
      get: noop,
      create: noop,
      update: noop,
      listComments: noop,
      createComment: noop,
      documents: { list: noop, get: noop, upsert: noop, delete: noop },
    },
    agents: {
      list: noop,
      get: noop,
      pause: noop,
      resume: noop,
      invoke: noop,
      sessions: { create: noop, list: noop, sendMessage: noop, close: noop },
    },
    goals: { list: noop, get: noop, create: noop, update: noop },
  } as unknown as HostServices;
  return { ...base, ...overrides } as HostServices;
}

describe("host-client-factory state.list", () => {
  it("delegates to services.state.list when capability is present", async () => {
    const rows = [
      {
        scopeKind: "instance",
        scopeId: null,
        namespace: "default",
        stateKey: "k1",
        value: { hi: 1 },
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ];
    const listSpy = vi.fn().mockResolvedValue(rows);
    const services = stubServices({
      state: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        list: listSpy,
      } as unknown as HostServices["state"],
    });
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: ["plugin.state.read"],
      services,
    });

    const result = await handlers["state.list"]({ scopeKind: "instance" });
    expect(listSpy).toHaveBeenCalledWith({ scopeKind: "instance" });
    expect(result).toEqual(rows);
  });

  it("throws CapabilityDeniedError without plugin.state.read", async () => {
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: ["plugin.state.write"],
      services: stubServices(),
    });

    await expect(handlers["state.list"]({})).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
