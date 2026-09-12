import { i18n } from "@/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  AI_CONNECTION_STATUS,
  aiMethodLabel,
  aiConnectionProblem,
  bindingProblem,
  matchesAiRequirement,
  personalAiDefault,
  type AiConnectionSummary,
  type AiConnectionRequirement,
  type AiConnectionBinding,
} from "./model";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(async () => { await i18n.changeLanguage("en"); });

const requirement: AiConnectionRequirement = {
  companyId: "company",
  provider: "anthropic",
  method: "subscription",
};
const account: AiConnectionSummary = {
  ...requirement,
  id: "connection",
  grantId: "grant",
  name: "Personal Claude",
  ownership: "personal",
  ownerUserId: "alice",
  status: "connected",
  isDefault: true,
};
const binding: AiConnectionBinding = {
  provider: "anthropic",
  method: "subscription",
  mode: "responsible_user",
};

describe("AI connection selection presentation", () => {
  it("scopes personal defaults to company, user, provider and method", () => {
    for (const change of [
      { companyId: "other" },
      { provider: "openai" as const },
      { method: "api_key" as const },
      { ownerUserId: "bob" },
      { ownership: "shared" as const },
    ]) {
      expect(
        personalAiDefault([{ ...account, ...change }], requirement, "alice"),
      ).toBeUndefined();
    }
    expect(personalAiDefault([account], requirement, "alice")).toBe(account);
  });
  it("retains a revoked default instead of falling back to a healthy account", () => {
    const revoked = { ...account, status: "revoked" as const };
    const alternate = { ...account, id: "alternate", isDefault: false };
    expect(personalAiDefault([alternate, revoked], requirement, "alice")).toBe(
      revoked,
    );
    expect(
      bindingProblem(
        binding,
        requirement,
        [alternate, revoked],
        "alice",
        "agent",
      ),
    ).toContain("Revoked");
  });
  it("does not select another user’s account", () => {
    expect(
      bindingProblem(binding, requirement, [account], "bob", "agent"),
    ).toContain("No connection");
  });
  it("does not infer a default from the first compatible connection", () => {
    expect(
      personalAiDefault(
        [{ ...account, isDefault: false }],
        requirement,
        "alice",
      ),
    ).toBeUndefined();
  });
  it("rejects incompatible bindings without modifying the requirement", () => {
    const original = { ...requirement };
    expect(
      bindingProblem(
        { ...binding, provider: "openai" },
        requirement,
        [account],
        "alice",
        "agent",
      ),
    ).toContain("compatible");
    expect(requirement).toEqual(original);
    expect(
      matchesAiRequirement({ ...account, method: "api_key" }, requirement),
    ).toBe(false);
  });
  it("requires exact grant identity and human access for a legacy personal selection", () => {
    const delegated = {
      provider: "anthropic",
      method: "subscription",
      mode: "delegated",
      connectionId: account.id,
      grantId: account.grantId,
    } as const;
    expect(
      bindingProblem(delegated, requirement, [account], "bob", "agent"),
    ).toContain("not shared with you");
    expect(
      bindingProblem(
        delegated,
        requirement,
        [account],
        "alice",
        "agent",
      ),
    ).toBeNull();
    expect(
      bindingProblem(
        { ...delegated, grantId: "different" },
        requirement,
        [account],
        "alice",
        "agent",
      ),
    ).toContain("no longer available");
  });
  it("does not mistake a personal account for shared", () => {
    expect(
      bindingProblem(
        {
          ...binding,
          mode: "shared",
          connectionId: account.id,
          grantId: account.grantId,
        },
        requirement,
        [account],
        "alice",
        "agent",
      ),
    ).toContain("company-shared");
  });
  it("preserves server-projected eligibility denials", () => {
    expect(
      aiConnectionProblem({
        ...account,
        unavailableReason: "Not in the shared audience",
      }),
    ).toBe("Not in the shared audience");
  });
});

it("localizes live helper output while retaining canonical defaults and raw diagnostics", async () => {
  const revoked = { ...account, status: "revoked" as const };
  for (const [locale, method, status] of [
    ["en", "Claude subscription", "Revoked"],
    ["ru", "Подписка Claude", "Доступ отозван"],
    ["en", "Claude subscription", "Revoked"],
  ]) {
    await i18n.changeLanguage(locale);
    expect(aiMethodLabel("anthropic", "subscription")).toBe(method);
    expect(AI_PROVIDERS.anthropic.subscriptionName).toBe(method);
    expect(AI_CONNECTION_STATUS.revoked).toBe(status);
    expect(aiConnectionProblem(revoked)).toContain(status);
    expect(personalAiDefault([revoked], requirement, "alice")).toBe(revoked);
    expect(aiConnectionProblem({ ...account, unavailableReason: "Custom provider denial" })).toBe("Custom provider denial");
    expect(binding.provider).toBe("anthropic");
    expect(binding.method).toBe("subscription");
    expect(binding.mode).toBe("responsible_user");
  }
  await i18n.changeLanguage("ru");
  expect(aiConnectionProblem({ ...account, unavailableReason: "Reconnect with a separate sign-in to protect your existing terminal login." })).toContain("сохранить текущую авторизацию в терминале");
});
