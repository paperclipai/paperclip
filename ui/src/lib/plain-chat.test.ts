// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAIN_SCRIPT_URL,
  getSupportChatWidgetStatus,
  hideSupportChat,
  mountSupportChat,
  resetSupportChatForTests,
  updateSupportChatTheme,
} from "./plain-chat";

type FakePlain = {
  init: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function createFakePlain(): FakePlain {
  return { init: vi.fn(), update: vi.fn(), open: vi.fn(), close: vi.fn() };
}

/** Capture the injected script tag so the test can settle its load. */
function captureScript() {
  const scripts: HTMLScriptElement[] = [];
  const originalAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    if (node instanceof HTMLScriptElement) scripts.push(node);
    return originalAppend(node);
  });
  return scripts;
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

const MOUNT = {
  appId: "liveChatApp_TEST",
  theme: "light" as const,
  customer: {
    email: "user@example.com",
    emailHash: "a".repeat(64),
    fullName: "User One",
  },
  identityKey: "user-1:verified",
};

describe("plain-chat controller", () => {
  beforeEach(() => {
    resetSupportChatForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { Plain?: unknown }).Plain;
  });

  it("injects the vendor script once and initializes with the attested identity", async () => {
    const scripts = captureScript();
    const fake = createFakePlain();

    const mounted = mountSupportChat(MOUNT);
    await tick();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe(PLAIN_SCRIPT_URL);
    expect(getSupportChatWidgetStatus()).toBe("loading");

    (window as unknown as { Plain: unknown }).Plain = fake;
    scripts[0]!.onload!(new Event("load"));
    await mounted;

    expect(getSupportChatWidgetStatus()).toBe("ready");
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.init).toHaveBeenCalledWith({
      appId: "liveChatApp_TEST",
      theme: "light",
      hideLauncher: false,
      customerDetails: {
        email: "user@example.com",
        emailHash: "a".repeat(64),
        fullName: "User One",
          },
    });
  });

  it("mounts without customerDetails when no identity is attested", async () => {
    const scripts = captureScript();
    const fake = createFakePlain();
    const mounted = mountSupportChat({ ...MOUNT, customer: null, identityKey: "user-1:anonymous" });
    await tick();
    (window as unknown as { Plain: unknown }).Plain = fake;
    scripts[0]!.onload!(new Event("load"));
    await mounted;

    expect(fake.init).toHaveBeenCalledWith({
      appId: "liveChatApp_TEST",
      theme: "light",
      hideLauncher: false,
    });
  });

  it("fails into the error state when the vendor script does not load", async () => {
    const scripts = captureScript();
    const mounted = mountSupportChat(MOUNT);
    await tick();
    scripts[0]!.onerror!(new Event("error"));
    await mounted;

    expect(getSupportChatWidgetStatus()).toBe("error");
  });

  it("refuses to rebind the page to a different identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scripts = captureScript();
    const fake = createFakePlain();
    const mounted = mountSupportChat(MOUNT);
    await tick();
    (window as unknown as { Plain: unknown }).Plain = fake;
    scripts[0]!.onload!(new Event("load"));
    await mounted;
    fake.update.mockClear();

    await mountSupportChat({ ...MOUNT, identityKey: "user-2:verified" });

    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("re-shows the launcher for the same identity with the full config", async () => {
    const scripts = captureScript();
    const fake = createFakePlain();
    const mounted = mountSupportChat(MOUNT);
    await tick();
    (window as unknown as { Plain: unknown }).Plain = fake;
    scripts[0]!.onload!(new Event("load"));
    await mounted;
    await hideSupportChat();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ hideLauncher: true }),
    );

    await mountSupportChat({ ...MOUNT, theme: "dark" });
    // Updates preserve the identity but omit the init-only app ID.
    expect(fake.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hideLauncher: false,
        theme: "dark",
        customerDetails: expect.objectContaining({ email: "user@example.com" }),
      }),
    );
  });

  it("runs a sign-out issued during script load strictly after the mount", async () => {
    const scripts = captureScript();
    const fake = createFakePlain();
    const mounted = mountSupportChat(MOUNT);
    const hidden = hideSupportChat();
    await tick();

    (window as unknown as { Plain: unknown }).Plain = fake;
    scripts[0]!.onload!(new Event("load"));
    await mounted;
    await hidden;

    // The widget initialized, then the queued hide closed and hid it.
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ hideLauncher: true }),
    );
  });

  it("keeps the widget theme in step with the product theme", async () => {
    const scripts = captureScript();
    const fake = createFakePlain();
    const mounted = mountSupportChat(MOUNT);
    await tick();
    (window as unknown as { Plain: unknown }).Plain = fake;
    scripts[0]!.onload!(new Event("load"));
    await mounted;

    await updateSupportChatTheme("dark");
    expect(fake.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });

  it("is a no-op to hide or retheme before the widget ever mounts", async () => {
    await hideSupportChat();
    await updateSupportChatTheme("dark");
    expect(getSupportChatWidgetStatus()).toBe("idle");
  });


  it("waits for async initialization before theme updates and omits init-only fields", async () => {
    const fake = createFakePlain();
    let finish!: () => void;
    fake.init.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    (window as unknown as { Plain: unknown }).Plain = fake;
    const mounted = mountSupportChat(MOUNT);
    const updated = updateSupportChatTheme("dark");
    await tick();
    expect(getSupportChatWidgetStatus()).toBe("loading");
    expect(fake.update).not.toHaveBeenCalled();
    finish();
    await mounted;
    await updated;
    expect(fake.update).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "dark",
      customerDetails: expect.objectContaining({ email: "user@example.com" }),
    }));
    expect(fake.update.mock.lastCall![0]).not.toHaveProperty("appId");
  });

  it("removes the stale widget and restores fallback after a rejected update", async () => {
    const fake = createFakePlain();
    (window as unknown as { Plain: unknown }).Plain = fake;
    const host = document.createElement("div");
    host.id = "plain-chat";
    document.body.appendChild(host);
    await mountSupportChat(MOUNT);
    fake.update.mockRejectedValue(new Error("vendor update rejected"));
    fake.close.mockImplementation(() => { throw new Error("close also failed"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await updateSupportChatTheme("dark");
    expect(getSupportChatWidgetStatus()).toBe("error");
    expect(document.getElementById("plain-chat")).toBeNull();
    const count = fake.update.mock.calls.length;
    await mountSupportChat(MOUNT);
    await updateSupportChatTheme("dark");
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.update).toHaveBeenCalledTimes(count);
    error.mockRestore();
  });

});
