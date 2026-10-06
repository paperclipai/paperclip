import { afterEach, describe, expect, it } from "vitest";
import { CHAT_EVENT_KINDS, CHAT_DELIVERY_STATES, type ChatActivityItem } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { chatActivitySummary } from "./chat-activity-copy";

const activity = (summary: string, overrides: Partial<ChatActivityItem> = {}): ChatActivityItem => ({
  id: "raw-event-id", kind: "delivery", status: "processed", summary,
  detail: "Provider response: message processed · 2 duplicates ignored",
  createdAt: "2026-09-11T10:00:00Z", ...overrides,
});
afterEach(async () => { await i18n.changeLanguage("en"); });

describe("first-party chat activity copy", () => {
  it.each([[1, "1 дубликат пропущен"], [2, "2 дубликата пропущены"], [5, "5 дубликатов пропущено"], [21, "21 дубликат пропущен"]] as const)(
    "localizes %s duplicates EN → RU → EN without changing the source event", async (count, expected) => {
      const summary = `message processed · ${count} duplicate${count === 1 ? "" : "s"} ignored`;
      const item = activity(summary);
      const original = JSON.stringify(item);
      for (const locale of ["en", "ru", "en"]) {
        await i18n.changeLanguage(locale);
        expect(chatActivitySummary(item)).toBe(locale === "ru" ? `Сообщение: событие обработано · ${expected}` : summary);
        expect(JSON.stringify(item)).toBe(original);
      }
    },
  );

  it("covers every declared inbound event and delivery state", async () => {
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const event of CHAT_EVENT_KINDS) for (const state of CHAT_DELIVERY_STATES) {
        const summary = `${event.replaceAll("_", " ")} ${state === "filtered" ? "ignored" : state}`;
        const rendered = chatActivitySummary(activity(summary, { status: state }));
        expect(rendered).not.toContain("chatActivity.");
        if (locale === "en") expect(rendered).toBe(summary);
        else expect(rendered).toMatch(/[А-Яа-яЁё]/);
      }
    }
  });

  it("updates publication, action, and recovery labels without translating provider diagnostics", async () => {
    const items = [
      activity("Response to external conversation", { kind: "publication" }),
      activity("waiting for input update", { kind: "publication" }),
      activity("Slack slash-command task start delivery unknown", { kind: "action", actionType: "slash_task_start", status: "delivery_unknown" }),
      activity("Slack session status", { kind: "action", actionType: "slack_session_sync" }),
      activity("GitHub webhook received after recovery request", { kind: "repair" }),
      activity("GitHub webhook recovery needs attention", { kind: "health" }),
    ];
    const before = JSON.stringify(items);
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const item of items) {
        const rendered = chatActivitySummary(item);
        expect(rendered).not.toContain("chatActivity.");
        if (locale === "ru") expect(rendered).toMatch(/[А-Яа-яЁё]/);
        else if (item.actionType !== "slash_task_start") expect(rendered).toBe(item.summary);
      }
      expect(JSON.stringify(items)).toBe(before);
    }
  });

  it("localizes every known Slack task-start state without changing its status identifier", async () => {
    const statuses = ["queued", "validating", "received", "resolving", "delivery_unknown", "provider_confirmed", "admitting", "processed", "failed", "cancelled"];
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const status of statuses) {
        const item = activity(`Slack slash-command task start ${status.replaceAll("_", " ")}`, { kind: "action", actionType: "slash_task_start", status });
        expect(chatActivitySummary(item)).toBe(i18n.t("chatActivity.slackTaskStart", { status: i18n.t(`status.${status}`) }));
        expect(chatActivitySummary(item)).not.toContain("status.");
        expect(item.status).toBe(status);
      }
    }
  });

  it("leaves unknown summaries, mismatched kinds, and diagnostic lookalikes verbatim", async () => {
    await i18n.changeLanguage("ru");
    for (const item of [
      activity("message processed · 2 duplicate ignored"),
      activity("message processed · 9007199254740993 duplicates ignored"),
      activity("message processed unexpected provider suffix"),
      activity("custom event processed"),
      activity("Response to external conversation"),
      activity("message processed", { status: "unknown_state" }),
      activity("Slack session status", { kind: "action", actionType: "provider_effect" }),
      activity("Slack slash-command task start future status", { kind: "action", actionType: "slash_task_start", status: "future_status" }),
      activity("Provider response: DO_NOT_TRANSLATE"),
    ]) expect(chatActivitySummary(item)).toBe(item.summary);
  });
});
