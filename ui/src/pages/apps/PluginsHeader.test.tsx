// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginsHeader } from "./PluginsHeader";

const reviewCount = vi.hoisted(() => ({ value: 0, apps: [] as string[] }));
vi.mock("./useReviewCount", () => ({ useReviewQueue: () => ({ count: reviewCount.value, loaded: true, apps: reviewCount.apps }) }));
vi.mock("./AppLogo", () => ({ AppLogo: ({ name }: { name: string }) => <span data-logo={name} /> }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));

const options = [{ id: "mcp", title: "MCP server URL", description: "A custom server.", href: "/apps/byo" }];

describe("PluginsHeader", () => {
  it("links to Reviews and offers Add when nothing is waiting", () => {
    reviewCount.value = 0;
    const html = renderToStaticMarkup(<PluginsHeader options={options} onNavigate={() => {}} />);
    expect(html).toContain('href="/apps/review"');
    expect(html).toContain('aria-label="Open Reviews"');
    expect(html).toContain("Add");
    expect(html).not.toContain("data-logo");
  });

  it("counts the requests waiting for review", () => {
    reviewCount.value = 3;
    reviewCount.apps = ["GitHub", "Slack"];
    const html = renderToStaticMarkup(<PluginsHeader options={options} onNavigate={() => {}} />);
    expect(html).toContain('aria-label="3 to review, open Reviews"');
    expect(html).toContain("3 to review");
    expect(html).toContain('data-logo="GitHub"');
    expect(html).toContain('data-logo="Slack"');
  });
});
