import { expect, it } from "vitest";
import { poolRunnerCooldownIdentity } from "../ai-connection-pool-cooldown.js";
it("scopes runner failures to credential, concrete harness and environment while sharing models", () => {
  const first = poolRunnerCooldownIdentity("secret:one:1", { provider: "codex", model: "a" }, "env-one");
  expect(first).toBe(poolRunnerCooldownIdentity("secret:one:1", { provider: "codex", model: "b" }, "env-one"));
  expect(first).not.toBe(poolRunnerCooldownIdentity("secret:one:1", { provider: "acpx", acpxAgent: "claude" }, "env-one"));
  expect(first).not.toBe(poolRunnerCooldownIdentity("secret:one:1", { provider: "codex" }, "env-two"));
  expect(first).not.toBe(poolRunnerCooldownIdentity("secret:one:2", { provider: "codex" }, "env-one"));
  expect(first).toMatch(/^runner:v2:[a-f0-9]{64}$/);
});

it("isolates runner failures across native and legacy engines on the same account", () => {
  const config = { provider: "codex" };
  const native = poolRunnerCooldownIdentity("secret:one:1", config, null);
  const cli = poolRunnerCooldownIdentity("secret:one:1", { ...config, engine: "cli" }, null, "codex_local");
  expect(cli).not.toBe(native);
  expect(cli).not.toBe(poolRunnerCooldownIdentity("secret:one:1", { ...config, engine: "acp" }, null, "codex_local"));
});
