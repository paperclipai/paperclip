import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { connectionNameForCredentialPolicy, connectionTypeLabel } from "./connection-identity";
import { customHeaderError, genericConnectGuidance, genericConnectPayload } from "./generic-mcp-connect";
import { defaultAiConnectionName } from "@/components/ai-connections/model";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("translates corrective guidance and header validation at call time without translating header identifiers", async () => {
  await i18n.changeLanguage("en");
  expect(customHeaderError([{ id: "one", name: "Host", value: "example.test" }])).toContain('Paperclip manages the "Host" header');
  await i18n.changeLanguage("zh-CN");
  expect(customHeaderError([{ id: "one", name: "Host", value: "example.test" }])).toBe('Paperclip 管理“Host”请求头，无法为其发送自定义值。');
  expect(genericConnectGuidance("mcp_remote_url_invalid", null).title).toBe("这似乎不是服务器地址");
});

it("keeps connection identity and credential request values identical across locales", async () => {
  const draft = { link: "https://example.test/mcp", name: "My connection", authMode: "custom_headers" as const, needsKey: false, keyValue: "", headers: [{ id: "one", name: "X-Api-Key", value: "unchanged-secret" }], oauthClientId: "", oauthClientSecret: "" };
  const snapshot = () => ({
    types: [connectionTypeLabel("per_user"), connectionTypeLabel("per_agent"), connectionTypeLabel("shared")],
    name: connectionNameForCredentialPolicy("Slack", "shared"),
    defaultAiName: defaultAiConnectionName(undefined, "anthropic", "subscription"),
    payload: genericConnectPayload(draft),
  });
  await i18n.changeLanguage("en");
  const english = snapshot();
  await i18n.changeLanguage("zh-CN");
  expect(snapshot()).toEqual(english);
  expect(snapshot().name).toBe("Slack for the organization");
});
