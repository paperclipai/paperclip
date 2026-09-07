// @vitest-environment node

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { queryKeys } from "../lib/queryKeys";
import { __liveUpdatesTestUtils as live } from "./LiveUpdatesProvider";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("live notification localization", () => {
  it("reads the current language per event without changing actor names, links, or deduplication", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.agents.list("company-1"), [{ id: "agent-1", name: "Agent Raw Name" }]);
    const payload = {
      entityType: "issue", entityId: "issue-1", actorType: "agent", actorId: "agent-1",
      action: "issue.created", details: { identifier: "PAP-42", title: "Keep my English task title" },
    };
    await i18n.changeLanguage("en");
    const english = live.buildActivityToast(client, "company-1", payload, { userId: null, agentId: null });
    expect(english?.title).toBe("Agent Raw Name created PAP-42");
    await i18n.changeLanguage("ru");
    const russian = live.buildActivityToast(client, "company-1", payload, { userId: null, agentId: null });
    expect(russian?.title).toBe("Agent Raw Name: создана PAP-42");
    expect(russian?.body).toBe("Keep my English task title");
    expect(russian?.action).toEqual({ label: "Открыть PAP-42", href: "/issues/issue-1" });
    expect(russian?.dedupeKey).toBe(english?.dedupeKey);
    expect(payload.details).toEqual({ identifier: "PAP-42", title: "Keep my English task title" });
    expect(live.buildActivityToast(client, "company-1", payload, { userId: null, agentId: "agent-1" })).toBeNull();
    client.clear();
  });

  it("translates owned change summaries while preserving unknown status values", async () => {
    const client = new QueryClient();
    const payload = {
      entityType: "issue", entityId: "issue-1", actorType: "system", action: "issue.updated",
      details: { identifier: "PAP-42", status: "in_review", priority: "high", assigneeAgentId: null },
    };
    await i18n.changeLanguage("ru");
    expect(live.buildActivityToast(client, "company-1", payload, { userId: null, agentId: null })?.body)
      .toBe("статус → на проверке, приоритет → высокий, исполнитель снят");
    payload.details.status = "provider_custom_state";
    expect(live.buildActivityToast(client, "company-1", payload, { userId: null, agentId: null })?.body)
      .toContain("provider custom state");
    expect(payload.details.status).toBe("provider_custom_state");
    await i18n.changeLanguage("en");
    expect(live.buildActivityToast(client, "company-1", payload, { userId: null, agentId: null })?.body)
      .toBe("status -> provider custom state, priority -> high, unassigned");
    client.clear();
  });

  it.each([
    ["failed", "error", "Agent Raw: запуск завершился с ошибкой"],
    ["timed_out", "error", "Agent Raw: время выполнения истекло"],
    ["cancelled", "warn", "Agent Raw: запуск отменён"],
  ])("preserves the %s lifecycle, tone, raw diagnostics, and navigation", async (status, tone, title) => {
    await i18n.changeLanguage("ru");
    const payload = { runId: "run-1", agentId: "agent-1", status, error: "Raw provider error: PATH=/my/file" };
    expect(live.buildRunStatusToast(payload, () => "Agent Raw")).toEqual({
      title, tone, body: payload.error, ttlMs: 7000,
      action: { label: "Открыть запуск", href: "/agents/agent-1/runs/run-1" },
      dedupeKey: `run-status:run-1:${status}`,
    });
    expect(live.buildRunStatusToast({ ...payload, status: "succeeded" }, () => "Agent Raw")).toBeNull();
  });

  it("keeps join-request identities and trigger values intact", async () => {
    await i18n.changeLanguage("ru");
    expect(live.buildJoinRequestToast({
      entityType: "join_request", entityId: "join-1", action: "join.requested", details: { requestType: "agent" },
    })).toEqual({
      title: "Агент запрашивает доступ", body: "Новый запрос на присоединение ожидает одобрения.", tone: "info",
      action: { label: "Открыть входящие", href: "/inbox/mine" }, dedupeKey: "join-request:join-1",
    });
    expect(live.buildRunStatusToast({ runId: "run-1", agentId: "agent-1", status: "failed", triggerDetail: "api_request" }, () => null)?.body)
      .toBe("Триггер: api_request");
  });
});
