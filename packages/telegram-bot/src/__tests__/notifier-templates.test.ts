import { describe, it, expect } from "vitest";
import {
  renderApproval,
  renderBlocked,
  renderDone,
  renderInteraction,
  renderWeeklyDigest,
  truncate,
} from "../notifier/templates.js";

describe("notifier templates", () => {
  it("interaction shows identifier, asking agent and reply hint", () => {
    const text = renderInteraction(
      { id: "i1", identifier: "THE-500", title: "Migrate users" },
      {
        id: "x1",
        issueId: "i1",
        kind: "ask_user_questions",
        status: "pending",
        title: "Approve cutover window?",
        summary: "We propose Saturday 02:00 UTC.",
        createdByAgentId: "a-cto",
      },
      { id: "a-cto", displayName: "CTO" },
    );
    expect(text).toContain("🔔");
    expect(text).toContain("[THE-500]");
    expect(text).toContain("Migrate users");
    expect(text).toContain("CTO просит: Approve cutover window?");
    expect(text).toContain("Saturday 02:00 UTC");
    expect(text).toContain("Reply на это сообщение → коммент в issue.");
  });

  it("approval includes summary, recommended action and slash commands", () => {
    const text = renderApproval({
      id: "ap-12345678",
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Approve hosting spend",
        summary: "$120/mo for provider X.",
        recommendedAction: "Approve provider X.",
        risks: ["Costs may scale with usage."],
      },
    });
    expect(text).toContain("✋ Approval needed: Approve hosting spend");
    expect(text).toContain("$120/mo for provider X.");
    expect(text).toContain("Recommended: Approve provider X.");
    expect(text).toContain("/approve ap-12345678");
    expect(text).toContain("/deny ap-12345678");
  });

  it("approval falls back to id when payload missing", () => {
    const text = renderApproval({
      id: "ap-deadbeef-x",
      status: "pending",
      payload: null,
    });
    expect(text).toContain("approval ap-deadb"); // truncated id label
    expect(text).toContain("/approve ap-deadbeef-x");
  });

  it("blocked surfaces unblock action when override given", () => {
    const text = renderBlocked(
      { id: "i2", identifier: "THE-501", title: "Deploy mobile app" },
      "Send build to TestFlight",
    );
    expect(text).toContain("🚧 [THE-501]");
    expect(text).toContain("Заблокирована, unblock owner = ты.");
    expect(text).toContain("Действие: Send build to TestFlight");
  });

  it("blocked falls back to default action text", () => {
    const text = renderBlocked({ id: "i3", identifier: "THE-502", title: "x" }, null);
    expect(text).toContain("Действие: проверь зависимости и сними блок.");
  });

  it("done shows assignee agent and trims long last comment", () => {
    const longBody = "ok ".repeat(200);
    const text = renderDone(
      { id: "i4", identifier: "THE-503", title: "Migrate logs" },
      { id: "a1", displayName: "Bot Engineer" },
      { id: "c1", body: longBody },
    );
    expect(text).toContain("✅ [THE-503]");
    expect(text).toContain("Ассигни: Bot Engineer");
    expect(text).toContain("Итог:");
    // tail is truncated to 200 chars
    const tail = text.split("Итог: ")[1] ?? "";
    expect(tail.length).toBeLessThanOrEqual(200);
  });

  it("done omits 'Итог:' when there's no last comment", () => {
    const text = renderDone(
      { id: "i5", identifier: "THE-504", title: "Wire monitoring" },
      { id: "a1" },
      null,
    );
    expect(text).not.toContain("Итог:");
  });

  it("truncate respects target length and adds ellipsis", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate(null, 10)).toBe("");
  });

  it("weekly_digest forwards comment body verbatim with header and source link", () => {
    const body = "# 📊 Weekly Board Digest — 2026-W19\n\n## Сделано\n- THE-100 — fix bug";
    const text = renderWeeklyDigest(
      { id: "issue-1", identifier: "THE-393", title: "CEO Weekly Board Digest" },
      { id: "c1", body },
    );
    expect(text).toContain("📊 Weekly Board Digest");
    expect(text).toContain("THE-100 — fix bug");
    expect(text).toContain(
      "📄 Источник: https://paperclip.thethirdchair.ru/THE/issues/THE-393",
    );
  });

  it("weekly_digest truncates body that would push the message over Telegram's 4096 limit", () => {
    const longBody = "x".repeat(8_000);
    const text = renderWeeklyDigest(
      { id: "issue-2", identifier: "THE-394", title: "Big Digest" },
      { id: "c2", body: longBody },
    );
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("…");
    expect(text).toContain("📄 Источник:");
  });

  it("weekly_digest falls back to issue id when identifier is null", () => {
    const text = renderWeeklyDigest(
      { id: "abc-uuid", identifier: null, title: "x" },
      { id: "c3", body: "tiny" },
    );
    expect(text).toContain(
      "📄 Источник: https://paperclip.thethirdchair.ru/THE/issues/abc-uuid",
    );
  });
});
