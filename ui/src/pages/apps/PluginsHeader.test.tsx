// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginsHeader } from "./PluginsHeader";

const reviewCount = vi.hoisted(() => ({ value: 0 }));
vi.mock("./useReviewCount", () => ({ useReviewCount: () => reviewCount.value }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));

const options = [{ id: "mcp", title: "MCP server URL", description: "A custom server.", href: "/apps/byo" }];

describe("PluginsHeader", () => {
  it("links to Review and offers Add when nothing is waiting", () => {
    reviewCount.value = 0;
    const html = renderToStaticMarkup(<PluginsHeader options={options} onNavigate={() => {}} />);
    expect(html).toContain('href="/apps/review"');
    expect(html).toContain('aria-label="Open Review"');
    expect(html).toContain("Add");
  });

  it("counts the requests waiting for review", () => {
    reviewCount.value = 3;
    const html = renderToStaticMarkup(<PluginsHeader options={options} onNavigate={() => {}} />);
    expect(html).toContain('aria-label="3 to review, open Review"');
    expect(html).toContain("3 to review");
  });
});
