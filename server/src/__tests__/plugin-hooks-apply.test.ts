import { describe, expect, it, vi } from "vitest";
import {
  applySkillResolverTransformers,
  applyWakePayloadTransformers,
  DEFAULT_SKILL_BUDGET_MS,
  DEFAULT_WAKE_BUDGET_MS,
} from "../services/plugin-hooks/apply.js";
import { createPluginHookRegistry } from "../services/plugin-hooks/registry.js";
import type {
  PluginHookIssueContext,
  WakePayload,
} from "../services/plugin-hooks/types.js";

const issue: PluginHookIssueContext = {
  issueId: "issue-1",
  companyId: "company-1",
  fields: { fastAction: true, mode: "fast" },
};

interface Recorded {
  applied: Array<{ pluginId: string; durationMs: number; hook: string }>;
  skipped: Array<{ pluginId: string; reason: string; hook: string }>;
  errors: Array<{ pluginId: string; reason: string; hook: string }>;
}

function recorder(): {
  sink: Parameters<typeof applyWakePayloadTransformers>[3] extends infer T
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

describe("applyWakePayloadTransformers", () => {
  it("returns the input untouched when the registry is empty", async () => {
    const registry = createPluginHookRegistry();
    const payload: WakePayload = { issueId: "i" };
    const out = await applyWakePayloadTransformers(registry, payload, { issue });
    expect(out).toBe(payload);
  });

  it("default budget exposed for documentation", () => {
    expect(DEFAULT_WAKE_BUDGET_MS).toBe(50);
    expect(DEFAULT_SKILL_BUDGET_MS).toBe(20);
  });

  it("invokes hooks in priority order and threads the payload", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-second",
      pluginKey: "second",
      priority: 50,
      handler: (payload) => ({ ...payload, sequence: [...((payload.sequence as string[]) ?? []), "second"] }),
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-first",
      pluginKey: "first",
      priority: 10,
      handler: (payload) => ({ ...payload, sequence: [...((payload.sequence as string[]) ?? []), "first"] }),
    });
    const out = await applyWakePayloadTransformers(registry, { sequence: [] }, { issue });
    expect(out.sequence).toEqual(["first", "second"]);
  });

  it("skips hooks whose `when` predicate is false", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-skip",
      pluginKey: "skip",
      when: { issueFieldEquals: { field: "fastAction", value: false } },
      handler: () => ({ shouldNotRun: true }),
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-run",
      pluginKey: "run",
      when: { issueHasField: "fastAction" },
      handler: (payload) => ({ ...payload, ran: true }),
    });
    const out = await applyWakePayloadTransformers(registry, {}, { issue }, { telemetry: sink });
    expect(out).toEqual({ ran: true });
    expect(recorded.skipped.map((e) => e.pluginId)).toEqual(["p-skip"]);
    expect(recorded.applied.map((e) => e.pluginId)).toEqual(["p-run"]);
  });

  it("isolates handler errors and continues the chain", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-throw",
      pluginKey: "throw",
      priority: 10,
      handler: () => {
        throw new Error("boom");
      },
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-good",
      pluginKey: "good",
      priority: 20,
      handler: (payload) => ({ ...payload, good: true }),
    });
    const out = await applyWakePayloadTransformers(
      registry,
      { initial: true },
      { issue },
      { telemetry: sink },
    );
    expect(out).toEqual({ initial: true, good: true });
    expect(recorded.errors).toMatchObject([{ pluginId: "p-throw", reason: "handler_threw" }]);
    expect(recorded.applied.map((e) => e.pluginId)).toEqual(["p-good"]);
  });

  it("rejects non-object handler returns and records handler_returned_invalid", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-bad",
      pluginKey: "bad",
      handler: () => "not an object" as never,
    });
    const out = await applyWakePayloadTransformers(
      registry,
      { initial: true },
      { issue },
      { telemetry: sink },
    );
    expect(out).toEqual({ initial: true });
    expect(recorded.errors[0]?.reason).toBe("handler_returned_invalid");
  });

  it("stops dispatching once the cumulative budget is exhausted", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    let virtualClock = 0;
    const tick = (ms: number) => {
      virtualClock += ms;
    };
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-slow-1",
      pluginKey: "slow-1",
      priority: 10,
      handler: async (payload) => {
        tick(40);
        return { ...payload, slow1: true };
      },
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-slow-2",
      pluginKey: "slow-2",
      priority: 20,
      handler: async (payload) => {
        tick(30);
        return { ...payload, slow2: true };
      },
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-skipped",
      pluginKey: "skipped",
      priority: 30,
      handler: () => ({ skipped: true }),
    });
    const out = await applyWakePayloadTransformers(
      registry,
      {},
      { issue },
      {
        telemetry: sink,
        budgetMs: 50,
        now: () => virtualClock,
      },
    );
    expect(out).toEqual({ slow1: true, slow2: true });
    expect(recorded.applied.map((e) => e.pluginId)).toEqual(["p-slow-1", "p-slow-2"]);
    expect(recorded.skipped[0]).toMatchObject({ pluginId: "p-skipped", reason: "budget_exhausted" });
  });

  it("times out a handler that exceeds the per-handler timeout", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-stuck",
      pluginKey: "stuck",
      handler: () => new Promise<never>(() => {}),
    });
    registry.register({
      kind: "wakePayloadTransformer",
      pluginId: "p-recover",
      pluginKey: "recover",
      handler: (payload) => ({ ...payload, recover: true }),
    });
    const out = await applyWakePayloadTransformers(
      registry,
      {},
      { issue },
      { telemetry: sink, perHandlerTimeoutMs: 5 },
    );
    expect(out).toEqual({ recover: true });
    expect(recorded.errors[0]?.reason).toBe("handler_timed_out");
  });
});

describe("applySkillResolverTransformers", () => {
  const skillContext = {
    issue,
    agentId: "agent-1",
    agentRole: "founding_engineer",
  };

  it("respects the 20ms default budget", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    let virtualClock = 0;
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      priority: 10,
      handler: (current) => {
        virtualClock += 15;
        return { skills: [...current.skills, "alpha"] };
      },
    });
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-2",
      pluginKey: "p-2",
      priority: 20,
      handler: (current) => {
        virtualClock += 10;
        return { skills: [...current.skills, "beta"] };
      },
    });
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-3",
      pluginKey: "p-3",
      priority: 30,
      handler: (current) => ({ skills: [...current.skills, "gamma"] }),
    });
    const out = await applySkillResolverTransformers(
      registry,
      { skills: ["base"] },
      skillContext,
      { telemetry: sink, now: () => virtualClock },
    );
    expect(out.skills).toEqual(["base", "alpha", "beta"]);
    expect(recorded.skipped[0]).toMatchObject({ pluginId: "p-3", reason: "budget_exhausted" });
  });

  it("normalises array results into SkillResolverResult", async () => {
    const registry = createPluginHookRegistry();
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-1",
      pluginKey: "p-1",
      handler: () => ["override"] as never,
    });
    const out = await applySkillResolverTransformers(
      registry,
      { skills: ["base"], required: ["base"] },
      skillContext,
    );
    expect(out.skills).toEqual(["override"]);
    expect(out.required).toEqual(["base"]);
  });

  it("rejects handler results with non-string entries", async () => {
    const registry = createPluginHookRegistry();
    const { sink, recorded } = recorder();
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-bad",
      pluginKey: "bad",
      handler: () => ({ skills: ["ok", 42 as unknown as string] }),
    });
    const out = await applySkillResolverTransformers(
      registry,
      { skills: ["base"] },
      skillContext,
      { telemetry: sink },
    );
    expect(out.skills).toEqual(["base"]);
    expect(recorded.errors[0]?.reason).toBe("handler_returned_invalid");
  });

  it("forwards onError callbacks for handler failures", async () => {
    const registry = createPluginHookRegistry();
    const onError = vi.fn();
    registry.register({
      kind: "skillResolverTransformer",
      pluginId: "p-err",
      pluginKey: "err",
      handler: () => {
        throw new Error("nope");
      },
    });
    await applySkillResolverTransformers(
      registry,
      { skills: ["base"] },
      skillContext,
      { onError },
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({
      hook: "skillResolverTransformer",
      pluginId: "p-err",
      reason: "handler_threw",
    });
  });
});
