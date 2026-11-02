// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ConnectionStatusMessage, pendingWritesCopy } from "../ConnectionStatusBanner";
import { PendingSendNotice } from "../PendingSendNotice";
import { CoordinatorRelativeTime, coordinatorRelativeLabel } from "./CoordinatorRelativeTime";
import { coordinatorReceiptLabel } from "./coordinator-labels";

describe("coordinator and reconnect localization", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });

  it("updates an already visible outage banner and uses Russian count forms", async () => {
    await act(async () => root.render(<ConnectionStatusMessage view="offline" pendingWrites={22} />));
    expect(host.textContent).toContain("22 changes will send");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(host.textContent).toContain("Нет подключения к сети");
    expect(host.textContent).toContain("22 изменения");
    expect(pendingWritesCopy(0)).toBeNull();
    for (const [count, expected] of [[1, "1 изменение"], [2, "2 изменения"], [5, "5 изменений"], [11, "11 изменений"], [21, "21 изменение"], [25, "25 изменений"], [101, "101 изменение"]] as const) {
      expect(pendingWritesCopy(count)).toContain(expected);
    }
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(host.textContent).toContain("22 changes will send");
  });

  it("changes pending task copy without losing resend and cancel actions", async () => {
    const resend = vi.fn(); const cancel = vi.fn();
    await act(async () => root.render(<PendingSendNotice noun="task" resending={false} stalled persisted onResendNow={resend} onCancel={cancel} />));
    expect(host.textContent).toContain("Your task is saved on this device.");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(host.textContent).toContain("Пока не удалось отправить задачу.");
    expect(host.textContent).toContain("Задача сохранена на этом устройстве.");
    await act(async () => { host.querySelectorAll("button")[0].click(); host.querySelectorAll("button")[1].click(); });
    expect(resend).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<PendingSendNotice noun="Custom payload" resending={false} stalled onCancel={cancel} />));
    expect(host.textContent).toContain("Custom payload");
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  it("localizes system receipt grammar while preserving authored choice labels", async () => {
    await i18n.changeLanguage("ru");
    expect(coordinatorReceiptLabel({ sourceKind: "issue_thread_interaction", label: "Approved" })).toBe("Одобрено");
    expect(coordinatorReceiptLabel({ sourceKind: "issue_thread_interaction", label: "2 approved · 5 rejected · 1 deferred" })).toBe("Одобрено: 2 · Отклонено: 5 · Отложено: 1");
    expect(coordinatorReceiptLabel({ sourceKind: "decision", label: "Approved" })).toBe("Approved");
    expect(coordinatorReceiptLabel({ sourceKind: "issue_thread_interaction", label: "Custom 2 approved label" })).toBe("Custom 2 approved label");
  });

  it("uses the selected language for relative and accessible exact dates", async () => {
    const value = new Date("2026-10-01T12:00:00Z");
    await act(async () => root.render(<CoordinatorRelativeTime value={value} />));
    const english = host.querySelector("time")!.title;
    await act(async () => { await i18n.changeLanguage("ru"); });
    const time = host.querySelector("time")!;
    expect(time.title).toBe(value.toLocaleString("ru", { dateStyle: "medium", timeStyle: "long" }));
    expect(time.title).not.toBe(english);
    expect(time.getAttribute("aria-label")).toBe(time.title);
    expect(time.dateTime).toBe(value.toISOString());
    expect(coordinatorRelativeLabel(value, value.getTime() + 120_000)).toBe("2 мин. назад");
    expect(coordinatorRelativeLabel("invalid", Date.now())).toBeNull();
  });
});
