import { afterEach, describe, expect, it } from "vitest";
import type { AiManagedConnectionSummary, CompanySecret } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import type { MyUserSecretEntry } from "../api/secrets";
import {
  savedProviderKeys,
  savedCodexSubscriptions,
  savedManagedProviderAccounts,
} from "./saved-provider-credentials";

afterEach(async () => { await i18n.changeLanguage("en"); });
const secret = (overrides = {}) =>
  ({
    id: "s1",
    companyId: "c1",
    key: "ANTHROPIC_API_KEY",
    name: "Claude",
    scope: "company",
    status: "active",
    ...overrides,
  }) as CompanySecret;
const personal = (key = "ANTHROPIC_API_KEY.setup.abc", overrides = {}) =>
  ({
    definition: {
      id: "d1",
      companyId: "c1",
      key,
      name: "My Claude",
      status: "active",
      ...overrides,
    },
    secret: secret({ scope: "user" }),
  }) as MyUserSecretEntry;
describe("saved provider keys", () => {
  it("reuses canonical and setup keys with references, including normalized organization keys", () => {
    expect(
      savedProviderKeys(
        "c1",
        "ANTHROPIC_API_KEY",
        [personal()],
        [secret({ key: "anthropic_api_key" })],
      ),
    ).toEqual([
      {
        id: "user:d1",
        label: "My Claude (Your key)",
        binding: {
          type: "user_secret_ref",
          key: "ANTHROPIC_API_KEY.setup.abc",
          version: "latest",
        },
      },
      {
        id: "company:s1",
        label: "Claude (Organization key)",
        binding: { type: "secret_ref", secretId: "s1", version: "latest" },
      },
    ]);
  });
  it("excludes unavailable, wrong-provider, and foreign-company credentials", () => {
    expect(
      savedProviderKeys(
        "c1",
        "ANTHROPIC_API_KEY",
        [
          personal("OPENAI_API_KEY"),
          personal(undefined, { status: "disabled" }),
          { ...personal(), secret: null },
          { ...personal(), secret: secret({ status: "archived" }) },
          personal(undefined, { companyId: "c2" }),
        ],
        [
          secret({ companyId: "c2" }),
          secret({ status: "disabled" }),
          secret({ scope: "user" }),
          secret({ key: "ANTHROPIC_API_KEY_OTHER" }),
        ],
      ),
    ).toEqual([]);
  });
});

it("lists only active company Codex account connections", () => {
  const account = secret({ name: "CODEX_HOME_team" });
  expect(
    savedCodexSubscriptions("c1", [
      account,
      { ...account, status: "disabled" },
      { ...account, companyId: "c2" },
      secret(),
    ]),
  ).toEqual([
    {
      id: "company:s1",
      label: "ChatGPT account · team",
      binding: { type: "secret_ref", secretId: "s1", version: "latest" },
    },
  ]);
});

it("retranslates eligible managed account labels without changing account names or bindings", async () => {
  const personalAccount = {
    id: "personal-account", grantId: "personal-grant", companyId: "c1", provider: "openai",
    method: "subscription", name: "My <OpenAI> subscription", ownership: "personal",
    ownerUserId: "user-1", status: "connected", isDefault: true,
  } as AiManagedConnectionSummary;
  const sharedAccount = {
    ...personalAccount, id: "shared-account", grantId: "shared-grant", name: "Team API key",
    ownership: "shared", method: "api_key", isDefault: false,
  } as AiManagedConnectionSummary;
  const accounts = [
    personalAccount, sharedAccount,
    { ...personalAccount, isDefault: false },
    { ...personalAccount, ownerUserId: "other-user" },
    { ...personalAccount, companyId: "other-company" },
    { ...personalAccount, provider: "anthropic" },
    { ...personalAccount, status: "revoked" },
  ] as AiManagedConnectionSummary[];
  const original = structuredClone(accounts);
  for (const locale of ["en", "ru", "en"]) {
    await i18n.changeLanguage(locale);
    expect(savedManagedProviderAccounts("c1", "openai", "user-1", accounts)).toEqual([
      {
        id: "ai:personal-grant",
        label: locale === "ru" ? "My <OpenAI> subscription (ваш аккаунт по умолчанию)" : "My <OpenAI> subscription (Your default)",
        aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" },
      },
      {
        id: "ai:shared-grant",
        label: locale === "ru" ? "Team API key (общий аккаунт организации)" : "Team API key (Company shared)",
        aiConnection: { provider: "openai", method: "api_key", mode: "shared", connectionId: "shared-account", grantId: "shared-grant" },
      },
    ]);
    expect(accounts).toEqual(original);
  }
});
