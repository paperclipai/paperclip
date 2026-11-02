import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { apiErrorMessage, classifyError, describeError, errorCopy, isConnectivityError } from "@/api/errors";
import { PendingSendAccountChangedError, classifySendFailure } from "@/lib/pending-send";
import { autosaveLabel } from "@/hooks/useDurableAutosave";
import { parseAgentConfigurationYaml } from "@/lib/agent-configuration-yaml";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { externalObjectCategoryLabel, externalObjectLivenessLabel } from "@/lib/external-objects";
import { sandboxProviderSchemaDisplay, sandboxProviderTextDisplay } from "@/lib/sandbox-provider-display";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("November 2 core localization", () => {
  it("translates owned error copy without changing classification or external diagnostics", async () => {
    const unavailable = { status: 503, body: { error: "tenant_app_unavailable" } };
    const worker = { status: 503, body: { code: "WORKER_UNAVAILABLE" } };
    const raw = "Provider: exact custom diagnostic — keep this text";
    await i18n.changeLanguage("ru");
    expect(describeError(unavailable).body).toBe("Paperclip перезапускается или обновляется. Повторите попытку чуть позже.");
    expect(classifyError(unavailable)).toBe("transient");
    expect(isConnectivityError(unavailable)).toBe(true);
    expect(isConnectivityError(worker)).toBe(false);
    expect(apiErrorMessage(403, { error: raw })).toBe(raw);
    expect(describeError({ status: 400, body: { message: raw } }).body).toBe(raw);
    expect(describeError({ status: 409 }, { action: "сохранить задачу" }).title).toBe("Не удалось сохранить задачу");
    await i18n.changeLanguage("en");
    expect(errorCopy("tenant_app_unavailable").title).toBe("Reconnecting to Paperclip");
    expect(apiErrorMessage(403, { error: raw })).toBe(raw);
  });

  it("keeps retained account errors and durable-save labels responsive to locale changes", async () => {
    const error = new PendingSendAccountChangedError();
    expect(classifySendFailure(error)).toBe("pending");
    await i18n.changeLanguage("ru");
    expect(error.message).toBe("Аккаунт изменился. Исходный запрос сохранён для его владельца.");
    expect(autosaveLabel("waiting", null)).toBe("Сохраним после восстановления подключения");
    await i18n.changeLanguage("en");
    expect(error.message).toBe("Your account changed. The original request is kept for its owner.");
    expect(autosaveLabel("stalled", null)).toBe("Automatic saving paused");
  });

  it("localizes YAML guardrails while leaving configuration identifiers and values intact", async () => {
    const yaml = 'apiVersion: paperclip/v1\nkind: Agent\nspec:\n  name: Original user name\n  adapterType: codex_local\n';
    await i18n.changeLanguage("en");
    const original = parseAgentConfigurationYaml(yaml);
    await i18n.changeLanguage("ru");
    expect(parseAgentConfigurationYaml(yaml)).toEqual(original);
    expect(() => parseAgentConfigurationYaml('apiVersion: &version paperclip/v1\nkind: Agent\nspec: {}')).toThrow("Якоря YAML не поддерживаются.");
  });

  it("localizes new runtime descriptions and rate-limit labels while preserving provider names and unknown categories", async () => {
    const antigravity = getAdapterDisplay("antigravity_runtime");
    await i18n.changeLanguage("ru");
    expect(antigravity.label).toBe("Google Antigravity");
    expect(antigravity.description).toBe("Antigravity через Paperclip Runner");
    expect(externalObjectCategoryLabel("rate_limited")).toBe("Превышен лимит запросов");
    expect(externalObjectLivenessLabel("rate_limited")).toBe("Превышен лимит запросов");
    expect(externalObjectCategoryLabel("custom-provider-state")).toBe("custom-provider-state");
    await i18n.changeLanguage("en");
    expect(antigravity.description).toBe("Antigravity through Paperclip Runner");
  });

  it("translates exact shipped sandbox metadata only in a copied display schema", async () => {
    const warning = "Optional wall-clock lifetime in minutes from creation. Daytona destroys the sandbox and its files at expiry in any state, even while active. Omit to leave the lifetime unchanged.";
    const schema = { type: "object", properties: { ttlMinutes: { type: "integer", minimum: 1, description: warning }, custom: { description: "Custom provider content", default: "USER_VALUE" } } };
    const original = JSON.stringify(schema);
    await i18n.changeLanguage("ru");
    const display = sandboxProviderSchemaDisplay("paperclip.daytona-sandbox-provider", schema);
    expect(display.properties.ttlMinutes.description).toContain("уничтожает песочницу и её файлы в любом состоянии");
    expect(display.properties.ttlMinutes.minimum).toBe(1);
    expect(display.properties.custom).toBe(schema.properties.custom);
    expect(JSON.stringify(schema)).toBe(original);
    expect(sandboxProviderSchemaDisplay("custom-plugin", schema)).toBe(schema);
    expect(sandboxProviderTextDisplay("paperclip.boxd-sandbox-provider", "boxd Machine")).toBe("Машина boxd");
    expect(sandboxProviderTextDisplay("custom-plugin", "boxd Machine")).toBe("boxd Machine");
    expect(sandboxProviderTextDisplay("paperclip.boxd-sandbox-provider", "Custom boxd description")).toBe("Custom boxd description");
  });
});
