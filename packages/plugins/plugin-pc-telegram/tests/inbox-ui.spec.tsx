/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendReply = vi.fn(async () => ({ sent: true }));
const refreshThread = vi.fn();
const navigate = vi.fn();

vi.mock("@paperclipai/plugin-sdk/ui", async () => {
  const React = await import("react");
  function atHour(dayOffset: number, hours: number, minutes: number) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hours, minutes, 0, 0);
    return date.toISOString();
  }
  function usePluginData(key: string, params?: Record<string, unknown>) {
    const paramsKey = JSON.stringify(params ?? null);
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
      setReady(true);
    }, [key, paramsKey]);
    const data = React.useMemo(() => {
      if (key === "overview") {
        return {
          connections: [
            { telegramUserId: "1", displayName: "Desk", username: null, assignedAgentId: null, incomingMode: "dialog", paused: false, live: true, hasSession: true },
          ],
        };
      }
      if (key === "chats") {
        return {
          chats: [
            { issueId: "issue-anna", identifier: "AND-1", label: "Анна", status: "todo", updatedAt: atHour(0, 9, 5), preview: "счёт", unread: 2 },
            { issueId: "issue-boris", identifier: "AND-2", label: "Борис", status: "todo", updatedAt: atHour(-1, 9, 5), preview: "доставка", unread: 0 },
          ],
        };
      }
      if (key === "chat-thread") {
        const beforeId = typeof params?.beforeId === "string" ? params.beforeId : "";
        if (beforeId && beforeId !== "0") return { found: true, live: true, messages: [] as Array<unknown> };
        return {
          found: true,
          live: true,
          label: "Анна",
          issueId: "issue-anna",
          identifier: "AND-1",
          messages: [
            { id: "m1", direction: "in", text: "Добрый день", at: atHour(0, 9, 0) },
            { id: "m2", direction: "out", text: "Hi", at: atHour(0, 9, 4) },
          ],
        };
      }
      return null;
    }, [key, paramsKey]);
    const noopRefresh = React.useMemo(() => () => undefined, []);
    const refresh = key === "chat-thread" ? refreshThread : noopRefresh;
    if (!ready) return { data: null, loading: true, error: null, refresh };
    return { data, loading: false, error: null, refresh };
  }
  return {
  usePluginData,
  usePluginAction: (name: string) => (name === "send-chat-reply" ? sendReply : vi.fn()),
  useHostLocation: () => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }),
  useHostNavigation: () => ({
    resolveHref: (to: string) => to,
    navigate,
    linkProps: (to: string) => ({
      href: to,
      onClick: (event: MouseEvent) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      },
    }),
  }),
  usePluginStream: () => ({
    events: [],
    lastEvent: null,
    connecting: false,
    connected: true,
    error: null,
    close: () => undefined,
  }),
  AssigneePicker: () => null,
  StatusBadge: () => null,
  };
});

import { TelegramChatsNav, TelegramInboxPage } from "../src/ui/index.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sendReply.mockClear();
  refreshThread.mockClear();
  navigate.mockClear();
  localStorage.setItem("paperclip.locale", "ru");
  window.history.pushState({}, "", "/BMC/telegram-inbox/AND-1");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  localStorage.clear();
});

async function renderInbox() {
  await act(async () => {
    root?.render(<TelegramInboxPage context={{ companyId: "company-1", companyPrefix: "BMC" }} />);
  });
}

describe("telegram inbox page", () => {
  it("renders the themed shell, search, dialog row, date, bubbles and composer in Russian", async () => {
    await renderInbox();
    const shell = host?.querySelector(".tg-shell");
    expect(shell).not.toBeNull();
    const css = host?.querySelector("style")?.textContent ?? "";
    expect(css).toContain("var(--card)");
    expect(css).toContain("var(--background)");
    expect(css).toContain("var(--primary)");
    expect(css).not.toContain("#212121");
    expect(css).not.toContain("#8774e1");
    expect(css).toContain("flex: 0 0 360px");
    expect(css).toContain("max-width: min(480px, 78%)");
    expect(css).toContain("width: 40px");
    expect(host?.querySelector(".tg-search-input")?.getAttribute("placeholder")).toBe("Поиск");
    expect(host?.querySelector(".tg-row.is-selected .tg-row-name")?.textContent).toBe("Анна");
    expect(host?.querySelector(".tg-badge")?.textContent).toBe("2");
    expect(host?.querySelector(".tg-date")?.textContent).toBe("Сегодня");
    const outgoing = host?.querySelector(".tg-bubble.out");
    expect(outgoing?.textContent).toContain("Hi");
    expect(outgoing?.querySelector(".tg-bubble-time")?.textContent).toMatch(/09:04|9:04/);
    expect(outgoing?.className).not.toContain("100");
    expect(host?.querySelector(".tg-composer-input")?.getAttribute("placeholder")).toBe("Сообщение");
    expect(host?.querySelector(".tg-send")?.getAttribute("aria-label")).toBe("Отправить");
    expect(host?.querySelector(".tg-task")?.textContent).toBe("Задача");
    expect(host?.querySelector(".tg-task")?.getAttribute("href")).toBe("/BMC/issues/AND-1");
    expect(host?.querySelector(".tg-back")).toBeNull();
    expect(host?.querySelector(".tg-send")?.hasAttribute("disabled")).toBe(true);
  });

  it("filters loaded dialogs locally and does not send an empty reply", async () => {
    await renderInbox();
    const input = host?.querySelector<HTMLInputElement>(".tg-search-input");
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "доставка");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const names = [...(host?.querySelectorAll(".tg-row-name") ?? [])].map((node) => node.textContent);
    expect(names).toEqual(["Борис"]);
    expect(sendReply).not.toHaveBeenCalled();
    const send = host?.querySelector<HTMLButtonElement>(".tg-send");
    await act(async () => {
      send?.click();
    });
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("sends the draft through send-chat-reply and leaves the task thread alone", async () => {
    await renderInbox();
    const field = host?.querySelector<HTMLTextAreaElement>(".tg-composer-input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "Короткий ответ");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = host?.querySelector<HTMLButtonElement>(".tg-send");
    expect(send?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      send?.click();
    });
    expect(sendReply).toHaveBeenCalledWith({
      companyId: "company-1",
      issueRef: "AND-1",
      text: "Короткий ответ",
    });
  });

  it("keeps a single column and a back button at 925px", async () => {
    class ResizeObserverStub {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const width = target.classList.contains("tg-feed") ? 400 : 800;
        this.callback([
          { contentRect: { width } } as ResizeObserverEntry,
        ], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    try {
      await renderInbox();
      expect(host?.querySelector(".tg-shell")?.classList.contains("is-narrow")).toBe(true);
      expect(host?.querySelector(".tg-list")).toBeNull();
      expect(host?.querySelector(".tg-back")?.getAttribute("aria-label")).toBe("Назад");
      expect(host?.querySelector(".tg-feed")?.classList.contains("is-compact")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches dialogs through the host router without remounting the shell", async () => {
    await renderInbox();
    const shell = host?.querySelector(".tg-shell");
    const boris = [...(host?.querySelectorAll("a.tg-row-body") ?? [])].find((node) => node.textContent?.includes("Борис"));
    expect(boris?.getAttribute("href")).toBe("/BMC/telegram-inbox/AND-2");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      boris?.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/BMC/telegram-inbox/AND-2");
    expect(host?.querySelector(".tg-shell")).toBe(shell);
    navigate.mockClear();
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    await act(async () => {
      boris?.dispatchEvent(modified);
    });
    expect(modified.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the Chats sidebar on accounts", async () => {
    await act(async () => {
      root?.render(<TelegramChatsNav context={{ companyId: "company-1", companyPrefix: "BMC" }} />);
    });
    const link = host?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/BMC/telegram-inbox");
    expect(link?.textContent).toContain("TG");
    expect(link?.textContent).toContain("Desk");
    expect(host?.textContent).not.toContain("Анна");
  });
});
