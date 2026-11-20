// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackSearchStatus } from "@paperclipai/shared";
import { SlackSearchView } from "./SlackToolSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: SlackSearchStatus = {
  configured: true,
  clientId: "1.2",
  redirectUri: "https://example.test/api/slack/search/callback",
  connected: false,
  nativeSearchAvailable: false,
  limitation: "limit",
};

describe("SlackSearchView DM reading opt-in", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (status: SlackSearchStatus, onConnect = vi.fn(async () => undefined)) => {
    act(() => {
      root.render(<SlackSearchView status={status} onConnect={onConnect} onDisconnect={async () => undefined} onConfigure={async () => undefined} />);
    });
    return onConnect;
  };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };

  it("connects without DM access unless the box is ticked", async () => {
    const onConnect = render(base);
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await click(button("Connect Slack search"));
    expect(onConnect).toHaveBeenLastCalledWith({ includeDms: false });
    await click(box);
    await click(button("Connect Slack search"));
    expect(onConnect).toHaveBeenLastCalledWith({ includeDms: true });
  });

  it("tells an unlinked person that connecting also links their Slack account, and still lets them connect", async () => {
    const onConnect = render({ ...base, linked: false });
    expect(container.textContent).toContain("isn’t linked to this connection yet");
    await click(button("Connect Slack search"));
    expect(onConnect).toHaveBeenCalledWith({ includeDms: false });
  });

  it("does not mention linking for a person who is already linked", () => {
    render({ ...base, linked: true });
    expect(container.textContent).not.toContain("isn’t linked");
  });

  it("shows DM reading as off and offers to allow it when connected without it", async () => {
    const onConnect = render({ ...base, connected: true, dmAccess: false });
    expect(container.textContent).toContain("Agents cannot read your direct messages");
    await click(button("Allow DM reading"));
    expect(onConnect).toHaveBeenCalledWith({ includeDms: true });
  });

  it("shows DM reading as on and offers to stop it", async () => {
    const onConnect = render({ ...base, connected: true, dmAccess: true });
    expect(container.textContent).toContain("Agents can read your direct messages and group DMs");
    await click(button("Stop DM reading"));
    expect(onConnect).toHaveBeenCalledWith({ includeDms: false });
  });
});
