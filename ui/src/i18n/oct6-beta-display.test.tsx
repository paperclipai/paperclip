// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { mcpSetupSteps, mcpAuthorizationHandoffInstructions, type AssistantClient } from "@paperclipai/shared";
import { assistantSetupDisplayText } from "@/pages/apps/assistant-setup-display";
import { aggregatorDiscoveryDisplayText } from "@/pages/apps/aggregator-discovery-display";
import { AiConnectionPoolRunDetails } from "@/components/ai-connections/AiConnectionPoolRunDetails";
import { buildMonitorSurfaceCopyDisplay } from "@/components/IssueMonitorBanner";
import { taskChatDisplayLabel, taskThreadMarkerDetailDisplay } from "@/components/task-chat/task-chat-display";
import { connectionDisplayNameForOwner } from "@/pages/apps/connection-owner";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("October 6 display-only localization", () => {
  it("translates every MCP setup explanation while preserving code, URLs, prompts and unknown text", async () => {
    const clients: AssistantClient[] = ["codex", "claude", "opencode", "browser", "headless", "other"];
    const fixtures = clients.map(client => mcpSetupSteps("https://local.example.test/mcp", client));
    const original = JSON.stringify(fixtures);
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      for (const step of fixtures.flat()) {
        const display = assistantSetupDisplayText(step.text);
        if (locale === "en") expect(display).toBe(step.text);
        else expect(display).toMatch(/[А-Яа-яЁё]/);
      }
      expect(assistantSetupDisplayText(mcpAuthorizationHandoffInstructions)).toBe(locale === "en" ? mcpAuthorizationHandoffInstructions : t("oct6Beta.mcpHandoff"));
      expect(assistantSetupDisplayText("Custom user's instructions")).toBe("Custom user's instructions");
      expect(assistantSetupDisplayText("__proto__")).toBe("__proto__");
      expect(assistantSetupDisplayText("toString")).toBe("toString");
      expect(JSON.stringify(fixtures)).toBe(original);
    }
  });

  it("projects only exact built-in discovery notices for the authoritative provider", async () => {
    const notices = [
      ["arcade", "Restore this gateway to check its accounts."],
      ["arcade", "Set up account sync to see your Arcade apps here."],
      ["composio", "Composio account discovery is unavailable on this gateway. Refresh its actions or check its setup."],
      ["executor", "Executor account discovery is unavailable on this server. You can still use the gateway’s actions."],
    ] as const;
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      for (const [provider, source] of notices) {
        const display = aggregatorDiscoveryDisplayText(provider, source);
        if (locale === "en") expect(display).toBe(source);
        else expect(display).toMatch(/[А-Яа-яЁё]/);
        expect(aggregatorDiscoveryDisplayText("custom", source)).toBe(source);
        expect(aggregatorDiscoveryDisplayText(provider, source + "\n")).toBe(source + "\n");
      }
      expect(aggregatorDiscoveryDisplayText("composio", "Set up account sync to see your Arcade apps here.")).toBe("Set up account sync to see your Arcade apps here.");
    }
  });

  it("keeps pool diagnostics and model identifiers raw while translating their captions", async () => {
    const context = { aiConnection: { accountName: "Original owner's account" }, aiRouterSelection: {
      poolId: "raw-pool", memberId: "raw-member", binding: { provider: "openai" }, runtimeConfig: { provider: "codex", model: "raw-model-id", effort: "custom-effort" },
      notes: ["Model override is unavailable for this member; using its default.", "Effort override is unavailable for this member; using its default.", "Unknown provider diagnostic"],
    } };
    const original = JSON.stringify(context);
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const html = renderToStaticMarkup(<AiConnectionPoolRunDetails context={context} />);
      expect(html).toContain(locale === "ru" ? "Переопределение модели" : "Model override");
      expect(html).toContain("raw-model-id");
      expect(html).toContain("custom-effort");
      expect(html).toContain("Unknown provider diagnostic");
      expect(JSON.stringify(context)).toBe(original);
    }
  });

  it("retains the pool wait explanation and model-rejection recovery in both languages", async () => {
    const state = { state: "retrying" as const, source: "scheduled-retry" as const, nextCheckAt: "2026-10-06T12:01:00Z", attemptCount: 4, serviceName: null };
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const copy = buildMonitorSurfaceCopyDisplay(state, new Date("2026-10-06T12:00:00Z"), "ai_connection_pool_wait")!;
      expect(copy.bannerTitle).toBe(t("oct6Beta.copy009"));
      expect(copy.bannerMeta.join(" ")).toContain(t("oct6Beta.copy010"));
      expect(copy.bannerMeta.join(" ")).not.toMatch(/Attempt|Попытка/);
      expect(taskChatDisplayLabel("Model unavailable")).toBe(t("oct6Beta.copy019"));
      expect(taskChatDisplayLabel("AI connection needed")).toBe(t("oct6Beta.copy025"));
      const detail = taskThreadMarkerDetailDisplay("RAW_provider/error Choose a supported model or clear the task's model override, then retry.");
      expect(detail).toContain("RAW_provider/error");
      expect(detail).toContain(locale === "ru" ? "Выберите поддерживаемую модель" : "Choose a supported model");
      const raw = "RAW_provider/error Choose a supported model or clear the task's model override, then retry.\n";
      expect(taskThreadMarkerDetailDisplay(raw)).toBe(raw);
    }
  });

  it("localizes known runtime effort labels without mutating pool selection", async () => {
    const context = { aiRouterSelection: { binding: { provider: "openai" }, runtimeConfig: { provider: "acpx", acpxAgent: "claude", model: "customer/model", effort: "high" }, notes: [] } };
    const original = JSON.stringify(context);
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const html = renderToStaticMarkup(<AiConnectionPoolRunDetails context={context} />);
      expect(html).toContain(locale === "ru" ? "OpenAI · Агенты ACP · Claude · customer/model · Высокая" : "OpenAI · ACP agents · Claude · customer/model · High");
      expect(JSON.stringify(context)).toBe(original);
    }
  });

  it("matches generic connection names canonically and translates only the visible default", async () => {
    await i18n.changeLanguage("ru");
    const owner = { label: "Alex Example", image: null };
    expect(connectionDisplayNameForOwner({ name: "Remote MCP" }, "Remote MCP", null, "Удалённый MCP")).toBe("Удалённый MCP");
    expect(connectionDisplayNameForOwner({ name: "Remote MCP" }, "Remote MCP", owner, "Удалённый MCP")).toContain("Удалённый MCP");
    expect(connectionDisplayNameForOwner({ name: "My MCP" }, "Remote MCP", owner, "Удалённый MCP")).toBe("My MCP");
    expect(connectionDisplayNameForOwner({ name: "Alex@Example.com" }, "Remote MCP", owner, "Удалённый MCP")).toBe("Alex@Example.com");
  });

  it.each([[0, "замечаний"], [1, "замечание"], [2, "замечания"], [5, "замечаний"], [11, "замечаний"], [21, "замечание"], [101, "замечание"]])("uses Russian notice plurals for %i", async (count, noun) => {
    await i18n.changeLanguage("ru");
    expect(t("oct6Beta.auditNotices", { count })).toContain(count + " " + noun);
  });
});
