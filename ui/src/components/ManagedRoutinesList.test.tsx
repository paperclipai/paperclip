// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { appearanceForPalette, agentAvatarUrl, resolveAgentAppearance } from "@paperclipai/shared";
import { ManagedRoutinesList } from "./ManagedRoutinesList";

vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));
const routines = [{ key: "routine", title: "Daily summary", status: "active", assigneeAgentId: "agent-one" }];
function avatarSrc(markup: string) {
  const document = new DOMParser().parseFromString(markup, "text/html");
  return document.querySelector('[data-slot="agent-avatar"] img')?.getAttribute("src");
}
describe("routine agent identities", () => {
  it("keeps a saved palette for agents without legacy icons", () => {
    const appearance = appearanceForPalette("bubblegum-sky");
    const markup = renderToStaticMarkup(<ManagedRoutinesList routines={routines} agents={[{ id: "agent-one", name: "One", appearance, icon: null }]} />);
    expect(avatarSrc(markup)).toBe(agentAvatarUrl(appearance, 16));
  });
  it("uses the assignee ID for a stable fallback before the agent summary loads", () => {
    const markup = renderToStaticMarkup(<ManagedRoutinesList routines={routines} />);
    expect(avatarSrc(markup)).toBe(agentAvatarUrl(resolveAgentAppearance(null, "agent-one"), 16));
  });
});
