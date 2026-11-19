import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { ActivityRow } from "./ActivityRow";
import { ActivityList } from "./ActivityList";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

const pluginId = "62c3f549-12e8-4ad4-a267-e0dfc4b4c011";
const event: ActivityEvent = {
  id: "activity-1",
  companyId: "company-1",
  actorType: "plugin",
  actorId: pluginId,
  action: "issue.updated",
  entityType: "issue",
  entityId: "issue-1",
  agentId: null,
  runId: null,
  details: null,
  createdAt: new Date("2026-11-02T00:00:00Z"),
};
const directories = {
  agentMap: new Map<string, Agent>(),
  entityNameMap: new Map([["issue:issue-1", "TEST-1"]]),
  entityTitleMap: new Map([["issue:issue-1", "Example task"]]),
};

describe.each(["default", "refreshed"] as const)("ActivityRow %s plugin actors", (appearance) => {
  it("renders the display name and keeps the task destination", () => {
    const html = renderToStaticMarkup(<ActivityRow {...directories} event={event} appearance={appearance} pluginNameMap={new Map([[pluginId, "Kitchen Sink (Example)"]])} />);
    expect(html).toContain("Kitchen Sink (Example)");
    expect(html).not.toContain(pluginId);
    expect(html).toContain('href="/issues/TEST-1"');
    expect(html).toContain("Example task");
  });

  it.each([undefined, new Map<string, string>(), new Map([[pluginId, "  "]])])("uses a short identifier when a name is unavailable", (pluginNameMap) => {
    const html = renderToStaticMarkup(<ActivityRow {...directories} event={event} appearance={appearance} pluginNameMap={pluginNameMap} />);
    expect(html).toContain("Plugin (62c3f549)");
    expect(html).not.toContain(pluginId);
  });

  it("uses a generic label when the actor ID is empty", () => {
    const html = renderToStaticMarkup(<ActivityRow {...directories} event={{ ...event, actorId: "" }} appearance={appearance} />);
    expect(html).toContain("Plugin");
    expect(html).not.toContain("Unknown");
  });

  it("renders plugin names as text", () => {
    const html = renderToStaticMarkup(<ActivityRow {...directories} event={event} appearance={appearance} pluginNameMap={new Map([[pluginId, "<script>example</script>"]])} />);
    expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it.each([
    ["agent", "Agent Name"],
    ["user", "User Name"],
    ["system", "System"],
  ] as const)("keeps %s actor resolution", (actorType, expectedName) => {
    const html = renderToStaticMarkup(<ActivityRow {...directories} event={{ ...event, actorType }} appearance={appearance}
      agentMap={new Map([[pluginId, { id: pluginId, name: "Agent Name" } as Agent]])}
      userProfileMap={new Map([[pluginId, { label: "User Name", image: null }]])}
      pluginNameMap={new Map([[pluginId, "Wrong plugin name"]])} />);
    expect(html).toContain(expectedName);
    expect(html).not.toContain("Wrong plugin name");
  });
});

it("passes the plugin directory through ActivityList", () => {
  const html = renderToStaticMarkup(<ActivityList {...directories} events={[event]} pluginNameMap={new Map([[pluginId, "Kitchen Sink (Example)"]])} />);
  expect(html).toContain("Kitchen Sink (Example)");
  expect(html).not.toContain(pluginId);
});
