// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type NotificationClickEvent = {
  notification: {
    data?: { href?: string | null };
    close: () => void;
  };
  waitUntil: (work: Promise<unknown>) => void;
};

function loadNotificationClickHandler(clients: {
  matchAll: (options: { type: string; includeUncontrolled: boolean }) => Promise<unknown[]>;
  openWindow?: (url: string) => Promise<unknown>;
}) {
  const handlers = new Map<string, (event: NotificationClickEvent) => void>();
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self: {
      location: { origin: "https://example.test" },
      addEventListener: (type: string, fn: (event: NotificationClickEvent) => void) => handlers.set(type, fn),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn(), ...clients },
    },
    URL,
    Response,
    fetch: vi.fn(),
    caches: { keys: async () => [], open: async () => ({ put: vi.fn(), delete: vi.fn(), match: vi.fn() }), match: vi.fn() },
  });
  const listener = handlers.get("notificationclick");
  if (!listener) throw new Error("sw.js registered no notificationclick listener");
  return listener;
}

async function clickNotification(
  listener: (event: NotificationClickEvent) => void,
  href?: string | null,
) {
  const close = vi.fn();
  let pending: Promise<unknown> | undefined;
  listener({
    notification: {
      data: href === undefined ? undefined : { href },
      close,
    },
    waitUntil: (work) => {
      pending = work;
    },
  });
  await pending;
  return close;
}

describe("sw.js notification click", () => {
  it("navigates and focuses an existing window to the stored href", async () => {
    const focused = { focus: vi.fn(async () => focused) };
    const client = {
      navigate: vi.fn(async () => focused),
      focus: vi.fn(async () => client),
    };
    const openWindow = vi.fn();
    const listener = loadNotificationClickHandler({
      matchAll: async () => [client],
      openWindow,
    });
    const close = await clickNotification(listener, "/PAP/inbox/mine");
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.navigate).toHaveBeenCalledWith("https://example.test/PAP/inbox/mine");
    expect(focused.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a window when no client is available", async () => {
    const openWindow = vi.fn(async () => ({}));
    const listener = loadNotificationClickHandler({
      matchAll: async () => [],
      openWindow,
    });
    await clickNotification(listener, "/PAP/agents/ada");
    expect(openWindow).toHaveBeenCalledWith("https://example.test/PAP/agents/ada");
  });

  it("focuses an existing window when the notification has no href", async () => {
    const client = {
      navigate: vi.fn(async () => client),
      focus: vi.fn(async () => client),
    };
    const openWindow = vi.fn();
    const listener = loadNotificationClickHandler({
      matchAll: async () => [client],
      openWindow,
    });
    await clickNotification(listener, null);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });
});
