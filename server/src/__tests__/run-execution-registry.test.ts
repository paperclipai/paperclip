import { afterEach, describe, expect, it } from "vitest";

import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.ts";
import type { ServerAdapterModule } from "../adapters/types.ts";
import {
  activeRunExecutions,
  adapterTracksLocalChildProcess,
  isRunExecutingInProcess,
} from "../services/run-execution-registry.ts";

function stubAdapter(type: string, tracksLocalChildProcess?: boolean): ServerAdapterModule {
  return {
    type,
    ...(tracksLocalChildProcess === undefined ? {} : { tracksLocalChildProcess }),
    async execute() {
      throw new Error("not used");
    },
    async testEnvironment() {
      throw new Error("not used");
    },
  } as ServerAdapterModule;
}

describe("adapterTracksLocalChildProcess", () => {
  const registered: string[] = [];

  afterEach(() => {
    while (registered.length > 0) unregisterServerAdapter(registered.pop()!);
    activeRunExecutions.clear();
  });

  function register(adapter: ServerAdapterModule) {
    registerServerAdapter(adapter);
    registered.push(adapter.type);
  }

  it("keeps the built-in local-child adapters authoritative", () => {
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(true);
    expect(adapterTracksLocalChildProcess("codex_local")).toBe(true);
    // hermes_local is built elsewhere and declares nothing, so it still resolves
    // through the legacy fallback list.
    expect(adapterTracksLocalChildProcess("hermes_local")).toBe(true);
  });

  it("does not trust an unknown adapter's recorded pid", () => {
    // A plugin adapter registered through adapter-plugins.json is not in the
    // legacy list. It may well work in-process and report one transient child
    // per tool call, so its recorded pid is not the run's liveness.
    expect(adapterTracksLocalChildProcess("unregistered_plugin_local")).toBe(false);
    expect(adapterTracksLocalChildProcess("")).toBe(false);
  });

  it("lets a plugin adapter declare the capability either way", () => {
    register(stubAdapter("plugin_opt_in", true));
    register(stubAdapter("plugin_opt_out", false));
    register(stubAdapter("plugin_silent"));

    expect(adapterTracksLocalChildProcess("plugin_opt_in")).toBe(true);
    expect(adapterTracksLocalChildProcess("plugin_opt_out")).toBe(false);
    expect(adapterTracksLocalChildProcess("plugin_silent")).toBe(false);
  });
});

describe("isRunExecutingInProcess", () => {
  afterEach(() => activeRunExecutions.clear());

  it("sees an in-process adapter execution, not only a child process handle", () => {
    // The recovery backstop used to read runningProcesses alone, so a run that
    // was live inside adapter.execute() looked exactly like a crashed one.
    expect(isRunExecutingInProcess("run-1")).toBe(false);
    activeRunExecutions.add("run-1");
    expect(isRunExecutingInProcess("run-1")).toBe(true);
    activeRunExecutions.delete("run-1");
    expect(isRunExecutingInProcess("run-1")).toBe(false);
  });
});
