import { describe, expect, it } from "vitest";
import { resolveHeartbeatNativeLifecyclePolicy, type NativeLifecyclePolicy } from "./native-lifecycle.js";

type Input = Parameters<typeof resolveHeartbeatNativeLifecyclePolicy>[0];
const warm: NativeLifecyclePolicy = { mode: "warm", idleTimeoutMs: 900_000 };
const perTurn: NativeLifecyclePolicy = { mode: "per_turn", idleTimeoutMs: null };
const base: Input = { adapterType: "paperclip_runner", backend: "codex_app_server", agentMode: "warm",
  agentIdleTimeoutMs: 900_000, managedAiSelected: false, taskOwned: false };

describe("admitted native lifecycle policy", () => {
  it.each<{ name: string; change: Partial<Input>; expected: NativeLifecyclePolicy }>([
    { name: "absent environment inherits agent warm", change: {}, expected: warm },
    { name: "inherited environment inherits agent warm", change: { environmentPolicy: null }, expected: warm },
    { name: "local selection inherits agent warm", change: { environmentPolicy: undefined }, expected: warm },
    { name: "explicit environment per-turn overrides agent warm", change: { environmentPolicy: perTurn }, expected: perTurn },
    { name: "explicit environment warm overrides agent per-turn", change: { agentMode: "per_turn", environmentPolicy: warm }, expected: warm },
    { name: "admitted per-turn stays pinned", change: { persistedPolicy: perTurn, environmentPolicy: warm }, expected: perTurn },
    { name: "admitted warm stays pinned", change: { persistedPolicy: warm, environmentPolicy: perTurn }, expected: warm },
    { name: "default agent is per-turn", change: { agentMode: undefined }, expected: perTurn },
    { name: "managed Codex supports warm", change: { managedAiSelected: true }, expected: warm },
    { name: "managed process provider without warm support is per-turn", change: { backend: "acpx_runtime", acpxAgent: "claude", managedAiSelected: true, environmentPolicy: warm }, expected: perTurn },
    { name: "unmanaged ACP retains its prior warm policy", change: { backend: "acpx_runtime", acpxAgent: "claude" }, expected: warm },
    { name: "Copilot API-key ownership supports warm", change: { backend: "acpx_runtime", acpxAgent: "copilot", managedAiSelected: true,
      managedAiAttribution: { provider: "github", method: "api_key" } }, expected: warm },
    { name: "unqualified Copilot ownership remains per-turn", change: { backend: "acpx_runtime", acpxAgent: "copilot", managedAiSelected: true,
      managedAiAttribution: { provider: "github", method: "subscription" } }, expected: perTurn },
    { name: "non-native adapter does not gain managed warm support", change: { adapterType: "codex_local", managedAiSelected: true }, expected: perTurn },
    { name: "task-owned provider keeps its existing ownership gate", change: { backend: "acpx_runtime", acpxAgent: "claude", managedAiSelected: true, taskOwned: true }, expected: warm },
    ...(["openai_dot_mcp", "grok_bot_mcp", "muse_external", "cursor_cloud_api"] as const).map(backend =>
      ({ name: `${backend} remains per-turn`, change: { backend, environmentPolicy: warm }, expected: perTurn })),
  ])("$name", ({ change, expected }) => {
    expect(resolveHeartbeatNativeLifecyclePolicy({ ...base, ...change })).toEqual(expected);
  });
});

describe("default lifecycle for an agent that never chose one", () => {
  const defaultWarm: NativeLifecyclePolicy = { mode: "warm", idleTimeoutMs: 300_000 };
  const unset: Input = { ...base, agentMode: undefined, agentIdleTimeoutMs: undefined, localTarget: true };
  it.each<{ name: string; change: Partial<Input>; expected: NativeLifecyclePolicy }>([
    { name: "local Codex keeps a warm runner for the default idle window", change: {}, expected: defaultWarm },
    { name: "local OpenCode is warm", change: { backend: "opencode_server" }, expected: defaultWarm },
    // ACPX relaunches its provider every follow-up turn, so warm buys Claude no TTFT.
    { name: "local Claude stays per-turn", change: { backend: "acpx_runtime", acpxAgent: "claude" }, expected: perTurn },
    { name: "an explicit per-turn choice is honored", change: { agentMode: "per_turn" }, expected: perTurn },
    { name: "an explicit warm idle window is honored", change: { agentMode: "warm", agentIdleTimeoutMs: 900_000 }, expected: warm },
    { name: "a remote target stays per-turn", change: { localTarget: false }, expected: perTurn },
    { name: "an unknown target stays per-turn", change: { localTarget: undefined }, expected: perTurn },
    { name: "an unmeasured ACP harness stays per-turn", change: { backend: "acpx_runtime", acpxAgent: "grok" }, expected: perTurn },
    { name: "managed Claude without warm support stays per-turn", change: { backend: "acpx_runtime", acpxAgent: "claude", managedAiSelected: true }, expected: perTurn },
    { name: "a session admitted per-turn before the default changed stays per-turn", change: { persistedPolicy: perTurn }, expected: perTurn },
    { name: "a non-native adapter stays per-turn", change: { adapterType: "codex_local" }, expected: perTurn },
  ])("$name", ({ change, expected }) => {
    expect(resolveHeartbeatNativeLifecyclePolicy({ ...unset, ...change })).toEqual(expected);
  });
});
