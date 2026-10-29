import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginPrepareAgentRunRequest } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import {
  PLUGIN_RUN_CONFIGURATION_TIMEOUT_MS, applyPluginRunAdapterConfig, applyPluginRunConfiguration, mergePluginRunDecisions, requestPluginRunConfiguration,
  type PluginRunConfigurator,
} from "./plugin-run-configuration.js";

const request: PluginPrepareAgentRunRequest = {
  companyId: "company", agentId: "agent", runId: "run", adapterType: "claude_local", invocationSource: "assignment",
  wakeReason: "issue_assigned", retryAttempt: 0, issueId: "issue",
  issue: { id: "issue", identifier: "FIX-1", title: "Fix the typo", description: "One word in the README." },
  adapterConfig: { model: "large-model", effort: "high" }, issueOverrides: {},
};

function workers(results: Record<string, () => unknown>, options: { running?: string[]; methods?: Record<string, string[]> } = {}) {
  const call = vi.fn(async (pluginId: string, _method: string, _params: PluginPrepareAgentRunRequest, _timeoutMs: number) => results[pluginId]!());
  const manager = {
    isRunning: (pluginId: string) => (options.running ?? Object.keys(results)).includes(pluginId),
    getWorker: (pluginId: string) => ({ supportedMethods: options.methods?.[pluginId] ?? ["prepareAgentRun"] }),
    call,
  } as unknown as Pick<PluginWorkerManager, "isRunning" | "getWorker" | "call">;
  return { manager, call };
}

const configurator = (id: string, capabilities: string[] = ["agent.runs.configure"]): PluginRunConfigurator => ({ id, pluginKey: `fixture.${id}`, capabilities });

describe("plugin run configuration", () => {
  it("returns allowlisted values and calls the worker with a bounded timeout", async () => {
    const { manager, call } = workers({ a: () => ({ adapterConfig: { model: "small-model", effort: "low" }, reason: "short task" }) });
    const decisions = await requestPluginRunConfiguration(manager, [configurator("a")], request);
    expect(decisions).toEqual([{ pluginKey: "fixture.a", adapterConfig: { model: "small-model", effort: "low" }, reason: "short task" }]);
    expect(call).toHaveBeenCalledWith("a", "prepareAgentRun", expect.objectContaining({ runId: "run" }), PLUGIN_RUN_CONFIGURATION_TIMEOUT_MS);
  });

  it("rejects a whole result that sets keys outside the allowlist", async () => {
    const { manager } = workers({ a: () => ({ adapterConfig: { model: "small-model", env: { TOKEN: "x" } } }) });
    expect(await requestPluginRunConfiguration(manager, [configurator("a")], request)).toEqual([]);
  });

  it("ignores failed, timed out, empty and null results", async () => {
    const { manager } = workers({
      a: () => { throw new Error("worker crashed"); },
      b: () => Promise.reject(new Error("RPC timed out")),
      c: () => null,
      d: () => ({ adapterConfig: {} }),
    });
    expect(await requestPluginRunConfiguration(manager, ["a", "b", "c", "d"].map((id) => configurator(id)), request)).toEqual([]);
  });

  it("calls only running plugins that declare the capability and implement the hook", async () => {
    const answer = () => ({ adapterConfig: { model: "small-model" } });
    const { manager, call } = workers({ a: answer, b: answer, c: answer, d: answer }, { running: ["a", "b", "c"], methods: { b: [] } });
    const decisions = await requestPluginRunConfiguration(manager, [configurator("a"), configurator("b"), configurator("c", ["issues.read"]), configurator("d")], request);
    expect(decisions.map((decision) => decision.pluginKey)).toEqual(["fixture.a"]);
    expect(call.mock.calls.map(([pluginId]) => pluginId)).toEqual(["a"]);
  });

  it("sends issue text only to plugins that may read issues", async () => {
    const { manager, call } = workers({ a: () => null, b: () => null });
    await requestPluginRunConfiguration(manager, [configurator("a"), configurator("b", ["agent.runs.configure", "issues.read"])], request);
    const sent = new Map(call.mock.calls.map(([pluginId, , params]) => [pluginId, params as PluginPrepareAgentRunRequest]));
    expect(sent.get("a")).toMatchObject({ issueId: "issue", issue: null });
    expect(sent.get("b")?.issue).toEqual(request.issue);
  });

  it("keeps the first plugin's value for each key in install order", () => {
    expect(mergePluginRunDecisions([
      { pluginKey: "first", adapterConfig: { model: "first-model" } },
      { pluginKey: "second", adapterConfig: { model: "second-model", effort: "medium" } },
    ])).toEqual({ model: "first-model", effort: "medium" });
  });

  it("reuses the decision recorded for the same run without calling plugins again", async () => {
    const { manager, call } = workers({ a: () => ({ adapterConfig: { model: "other-model" } }) });
    const run = { id: "run", companyId: "company", invocationSource: "assignment", scheduledRetryAttempt: 0 } as Parameters<typeof applyPluginRunConfiguration>[1]["run"];
    const appendRunEvent = vi.fn();
    const input = { run, agent: { id: "agent", companyId: "company", adapterType: "claude_local" }, config: {}, issue: null, issueOverrides: null };
    const services = { workerManager: manager as PluginWorkerManager, appendRunEvent };
    const recorded = await applyPluginRunConfiguration({} as Db, { ...input, context: { pluginRunConfiguration: { runId: "run", adapterConfig: { model: "small-model" }, decisions: [] } } }, services);
    expect(recorded).toEqual({ adapterConfig: { model: "small-model" }, useProjectWorkspace: null });
    expect(call).not.toHaveBeenCalled();
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("lets per-issue overrides win over the plugin decision", () => {
    expect(applyPluginRunAdapterConfig({ adapterConfig: { model: "operator-model", cwd: "/work" }, useProjectWorkspace: true }, { model: "small-model", effort: "low" }))
      .toEqual({ adapterConfig: { model: "operator-model", effort: "low", cwd: "/work" }, useProjectWorkspace: true });
    expect(applyPluginRunAdapterConfig(null, { effort: "low" })).toEqual({ adapterConfig: { effort: "low" }, useProjectWorkspace: null });
    expect(applyPluginRunAdapterConfig(null, {})).toBeNull();
  });
});
