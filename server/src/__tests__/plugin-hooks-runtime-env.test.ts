import { describe, expect, it } from "vitest";
import {
  applyRuntimeEnvProviderHooks,
  DEFAULT_RUNTIME_ENV_BUDGET_MS,
} from "../services/plugin-hooks/apply.js";
import { createPluginHookRegistry } from "../services/plugin-hooks/registry.js";
import {
  EMPTY_RUNTIME_ENV_RESULT,
  type PluginHookIssueContext,
  type RuntimeEnvProviderContext,
} from "../services/plugin-hooks/types.js";

const issue: PluginHookIssueContext = {
  issueId: "issue-1",
  companyId: "company-1",
  fields: { adapterType: "claude_local" },
};

function makeContext(
  override: Partial<RuntimeEnvProviderContext> = {},
): RuntimeEnvProviderContext {
  return {
    issue,
    agentId: "agent-1",
    agentRole: "engineer",
    companyId: "company-1",
    runId: "run-1",
    adapterType: "claude_local",
    adapterConfig: {},
    ...override,
  };
}

interface Recorded {
  applied: Array<{ pluginId: string; durationMs: number; hook: string }>;
  skipped: Array<{ pluginId: string; reason: string; hook: string }>;
  errors: Array<{ pluginId: string; reason: string; hook: string }>;
}

function recorder(): {
  sink: Parameters<typeof applyRuntimeEnvProviderHooks>[2] extends infer T
    ? T extends { telemetry?: infer S }
      ? NonNullable<S>
      : never
    : never;
  recorded: Recorded;
} {
  const recorded: Recorded = { applied: [], skipped: [], errors: [] };
  const sink = {
    recordApplied(args: { pluginId: string; durationMs: number; hook: string }) {
      recorded.applied.push({ pluginId: args.pluginId, durationMs: args.durationMs, hook: args.hook });
    },
    recordSkipped(args: { pluginId: string; reason: string; hook: string }) {
      recorded.skipped.push({ pluginId: args.pluginId, reason: args.reason, hook: args.hook });
    },
    recordError(args: { pluginId: string; reason: string; hook: string }) {
      recorded.errors.push({ pluginId: args.pluginId, reason: args.reason, hook: args.hook });
    },
  } as never;
  return { sink, recorded };
}

describe("applyRuntimeEnvProviderHooks", () => {
  it("returns the empty result when the registry is empty", async () => {
    const registry = createPluginHookRegistry();
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out).toBe(EMPTY_RUNTIME_ENV_RESULT);
    expect(out.env).toEqual({});
    expect(out.runtimeFiles).toBeUndefined();
  });

  it("default budget exposed for documentation", () => {
    expect(DEFAULT_RUNTIME_ENV_BUDGET_MS).toBe(200);
  });

  it("registers and merges env from a single hook (FOO=bar acceptance)", async () => {
    // MYO-80 acceptance: a third-party plugin injects FOO=bar and the merged
    // result exposes it to the spawn caller.
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "third-party.gh-identity",
      pluginKey: "gh-identity",
      handler: () => ({ env: { FOO: "bar" } }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out.env).toEqual({ FOO: "bar" });
  });

  it("threads context (agentId, runId, adapterType) into each handler", async () => {
    const registry = createPluginHookRegistry();
    let observed: RuntimeEnvProviderContext | null = null;
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-observe",
      pluginKey: "observe",
      handler: (current, ctx) => {
        observed = ctx;
        return current;
      },
    });
    await applyRuntimeEnvProviderHooks(
      registry,
      makeContext({ agentId: "agent-99", runId: "run-99", adapterType: "codex_local" }),
    );
    expect(observed).toMatchObject({
      agentId: "agent-99",
      runId: "run-99",
      adapterType: "codex_local",
      companyId: "company-1",
    });
  });

  it("merges env in priority order with last-write-wins semantics", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-low",
      pluginKey: "low",
      priority: 10,
      handler: () => ({ env: { GIT_AUTHOR_NAME: "low-priority" } }),
    });
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-high",
      pluginKey: "high",
      priority: 20,
      handler: (current) => ({
        env: { ...current.env, GIT_AUTHOR_NAME: "high-priority" },
      }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out.env).toEqual({ GIT_AUTHOR_NAME: "high-priority" });
  });

  it("skips hooks whose `when` predicate is false", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-only-codex",
      pluginKey: "only-codex",
      when: { issueFieldEquals: { field: "adapterType", value: "codex_local" } },
      handler: () => ({ env: { CODEX_ONLY: "1" } }),
    });
    const out = await applyRuntimeEnvProviderHooks(
      registry,
      makeContext({ adapterType: "claude_local" }),
      { telemetry: sink },
    );
    expect(out.env).toEqual({});
    expect(recorded.skipped[0]?.reason).toBe("predicate_false");
  });

  it("isolates handler errors and continues the chain", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-throw",
      pluginKey: "throw",
      priority: 10,
      handler: () => {
        throw new Error("boom");
      },
    });
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-good",
      pluginKey: "good",
      priority: 20,
      handler: (current) => ({ env: { ...current.env, GOOD: "1" } }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext(), { telemetry: sink });
    expect(out.env).toEqual({ GOOD: "1" });
    expect(recorded.errors).toMatchObject([{ pluginId: "p-throw", reason: "handler_threw" }]);
    expect(recorded.applied.map((e) => e.pluginId)).toEqual(["p-good"]);
  });

  it("rejects invalid env keys (not POSIX-portable) and records handler_returned_invalid", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-bad-key",
      pluginKey: "bad-key",
      handler: () => ({ env: { "BAD-KEY!": "value" } }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext(), { telemetry: sink });
    expect(out.env).toEqual({});
    expect(recorded.errors[0]?.reason).toBe("handler_returned_invalid");
  });

  it("rejects non-string env values", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-num",
      pluginKey: "num",
      handler: () => ({ env: { COUNT: 7 } }) as never,
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext(), { telemetry: sink });
    expect(out.env).toEqual({});
    expect(recorded.errors[0]?.reason).toBe("handler_returned_invalid");
  });

  it("accepts runtimeFiles with relative paths and applies a default 0o600 mode", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-files",
      pluginKey: "files",
      handler: () => ({
        env: { GIT_CONFIG_GLOBAL: ".gitconfig" },
        runtimeFiles: [{ path: ".gitconfig", content: "[user]\n  name = bot" }],
      }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out.runtimeFiles).toEqual([
      { path: ".gitconfig", content: "[user]\n  name = bot", mode: 0o600 },
    ]);
  });

  it("rejects absolute paths and parent-traversal segments without aborting the chain", async () => {
    const registry = createPluginHookRegistry();
    const errors: Array<{ reason: string; pluginId: string }> = [];
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-escape",
      pluginKey: "escape",
      handler: () => ({
        env: {},
        runtimeFiles: [
          { path: "/etc/passwd", content: "rooted" },
          { path: "../escape", content: "traversal" },
          { path: "C:\\Windows\\evil.txt", content: "windows" },
          { path: "ok.txt", content: "kept" },
        ],
      }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext(), {
      onError: (event) => errors.push({ reason: event.reason, pluginId: event.pluginId }),
    });
    expect(out.runtimeFiles).toEqual([
      { path: "ok.txt", content: "kept", mode: 0o600 },
    ]);
    expect(errors.filter((e) => e.reason === "runtime_file_rejected")).toHaveLength(3);
  });

  it("normalises file paths and preserves explicit mode bits", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-mode",
      pluginKey: "mode",
      handler: () => ({
        env: {},
        runtimeFiles: [
          { path: "nested//dir///file.txt", content: "ok", mode: 0o644 },
          // Non-mode bits (setuid 0o4000) get clamped away by the host.
          { path: "secret", content: "k", mode: 0o4600 },
        ],
      }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    const sorted = (out.runtimeFiles ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([
      { path: "nested/dir/file.txt", content: "ok", mode: 0o644 },
      { path: "secret", content: "k", mode: 0o4600 & 0o7777 },
    ]);
  });

  it("later runtimeFiles overwrite earlier entries for the same path (last-write-wins)", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-first",
      pluginKey: "first",
      priority: 10,
      handler: () => ({
        env: {},
        runtimeFiles: [{ path: ".gitconfig", content: "first" }],
      }),
    });
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-second",
      pluginKey: "second",
      priority: 20,
      handler: (current) => ({
        env: current.env,
        runtimeFiles: [
          ...(current.runtimeFiles ?? []),
          { path: ".gitconfig", content: "second" },
        ],
      }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out.runtimeFiles).toEqual([
      { path: ".gitconfig", content: "second", mode: 0o600 },
    ]);
  });

  it("stops dispatching once the cumulative budget is exhausted", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    let virtualClock = 0;
    const tick = (ms: number) => {
      virtualClock += ms;
    };
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-slow-1",
      pluginKey: "slow-1",
      priority: 10,
      handler: async (current) => {
        tick(120);
        return { env: { ...current.env, FIRST: "1" } };
      },
    });
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-slow-2",
      pluginKey: "slow-2",
      priority: 20,
      handler: async (current) => {
        tick(120);
        return { env: { ...current.env, SECOND: "1" } };
      },
    });
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-skipped",
      pluginKey: "skipped",
      priority: 30,
      handler: () => ({ env: { SKIPPED: "1" } }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext(), {
      telemetry: sink,
      budgetMs: 200,
      now: () => virtualClock,
    });
    expect(out.env).toEqual({ FIRST: "1", SECOND: "1" });
    expect(recorded.applied.map((e) => e.pluginId)).toEqual(["p-slow-1", "p-slow-2"]);
    expect(recorded.skipped.map((e) => e.pluginId)).toContain("p-skipped");
  });

  it("does not call hooks when the registry is globally disabled", async () => {
    const registry = createPluginHookRegistry({ enabled: false });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out).toBe(EMPTY_RUNTIME_ENV_RESULT);
  });

  it("respects the per-company hook feature flag", async () => {
    const registry = createPluginHookRegistry({
      isHooksEnabledForCompany: (companyId) => companyId !== "company-1",
    });
    registry.register({
      kind: "runtimeEnvProvider",
      pluginId: "p-blocked-company",
      pluginKey: "blocked",
      handler: () => ({ env: { LEAK: "should-not-appear" } }),
    });
    const out = await applyRuntimeEnvProviderHooks(registry, makeContext());
    expect(out.env).toEqual({});
  });
});
