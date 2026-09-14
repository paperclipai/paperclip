// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementCard } from "./AnnouncementCard";
import { announcementPreview } from "@/lib/announcement-preview";

vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("AnnouncementCard", () => {
  it("renders accessible plain text, navigational actions, image fallback and dismissal", async () => {
    const div = document.createElement("div"); document.body.append(div);
    const root = createRoot(div);
    const dismiss = vi.fn();
    await act(async () => root.render(<AnnouncementCard announcement={{ ...announcementPreview, title: "<script>hello</script>" }} onDismiss={dismiss} />));
    expect(div.querySelector("script")).toBeNull();
    expect(div.querySelector("h2")?.textContent).toBe("<script>hello</script>");
    expect(div.querySelector('[role="region"]')?.getAttribute("aria-labelledby")).toBe(div.querySelector("h2")?.id);
    expect(div.querySelector('a[href="https://paperclip.ing"]')?.getAttribute("rel")).toContain("noreferrer");
    expect(div.querySelector('a[href="/projects"]')).not.toBeNull();
    await act(async () => div.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(div.querySelector("img")).toBeNull();
    await act(async () => div.querySelector("button")!.click());
    expect(dismiss).toHaveBeenCalledTimes(1);
    await act(async () => div.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dismiss).toHaveBeenCalledTimes(2);
    for (const link of div.querySelectorAll("a")) {
      await act(async () => link.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })));
    }
    expect(dismiss).toHaveBeenCalledTimes(4);
    await act(async () => div.querySelector("a")!.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true })));
    expect(dismiss).toHaveBeenCalledTimes(4); // Opening a context menu is not navigation.
    await act(async () => root.unmount()); div.remove();
  });
});
