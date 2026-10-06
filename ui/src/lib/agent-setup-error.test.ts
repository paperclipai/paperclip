import { afterEach, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { ManagedSandboxUnavailableForTestError } from "./adapter-test-environment";
import { AgentSetupError, agentSetupErrorText } from "./agent-setup-error";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("translates only the first-party sandbox error class and preserves frozen provider diagnostics", async () => {
  const builtin = Object.freeze(new ManagedSandboxUnavailableForTestError());
  const originalMessage = builtin.message;
  const provider = Object.freeze(new Error(originalMessage));
  const other = Object.freeze(new Error("Custom provider failure: model-id/42"));
  for (const [locale, expected] of [
    ["en", originalMessage],
    ["ru", "В этом экземпляре агенты работают только в управляемой песочнице, но среда песочницы для проверки недоступна. Убедитесь, что провайдер управляемой песочницы активен, и повторите проверку."],
    ["en", originalMessage],
  ]) {
    await i18n.changeLanguage(locale);
    expect(agentSetupErrorText(builtin, t)).toBe(expected);
    expect(agentSetupErrorText(provider, t)).toBe(originalMessage);
    expect(agentSetupErrorText(other, t)).toBe(other.message);
    expect(builtin.message).toBe(originalMessage);
    expect(agentSetupErrorText(null, t)).toBeNull();
  }
});

it("preserves an external cause when rendering a localized setup error", async () => {
  const external = Object.freeze(new Error("Provider says: UNAVAILABLE"));
  const wrapped = new AgentSetupError("agentSetup.testAgentFailed", {}, external);
  await i18n.changeLanguage("ru");
  expect(agentSetupErrorText(wrapped, t)).toBe(`Provider says: UNAVAILABLE ${t("agentSetup.testAgentFailed")}`);
  await i18n.changeLanguage("en");
  expect(agentSetupErrorText(wrapped, t)).toBe(`Provider says: UNAVAILABLE ${t("agentSetup.testAgentFailed")}`);
});
