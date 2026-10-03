import { describe, expect, it, vi } from "vitest";
import { mentionChipInlineStyle } from "./mention-chips";

const getAgentIcon = vi.hoisted(() => vi.fn());
vi.mock("./agent-icons", () => ({ getAgentIcon }));

describe("agent mention icon compatibility", () => {
  const node = [["path", { d: "m16 18 6-6-6-6", key: "code" }]];

  it.each([
    ["static", { iconNode: node }],
    ["legacy", { render: () => ({ props: { iconNode: node } }) }],
    ["icon-data", { render: () => ({ props: { icon: { name: "code", size: 24, node } } }) }],
  ])("renders an agent mention mask from Lucide's %s format", (name, icon) => {
    getAgentIcon.mockReturnValue(icon);
    const style = mentionChipInlineStyle({ kind: "agent", agentId: "agent", icon: name });
    const mask = (style as Record<string, string>)["--paperclip-mention-icon-mask"];
    expect(decodeURIComponent(mask)).toContain('<path d="m16 18 6-6-6-6"></path>');
  });
});
