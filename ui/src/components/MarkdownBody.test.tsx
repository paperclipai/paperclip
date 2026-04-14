// @vitest-environment node

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAgentMentionHref, buildProjectMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

function renderMarkdown(children: string, seededIssues: Array<{ identifier: string; status: string }> = []) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  for (const issue of seededIssues) {
    queryClient.setQueryData(queryKeys.issues.detail(issue.identifier), {
      id: issue.identifier,
      identifier: issue.identifier,
      status: issue.status,
    });
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MarkdownBody>{children}</MarkdownBody>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("MarkdownBody", () => {
  it("renders markdown images without a resolver", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody>{"![](/api/attachments/test/content)"}</MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('<img src="/api/attachments/test/content" alt=""/>');
  });

  it("resolves relative image paths when a resolver is provided", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody resolveImageSrc={(src) => `/resolved/${src}`}>
            {"![Org chart](images/org-chart.png)"}
          </MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('src="/resolved/images/org-chart.png"');
    expect(html).toContain('alt="Org chart"');
  });

  it("renders agent, project, and skill mentions as chips", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody>
            {`[@CodexCoder](${buildAgentMentionHref("agent-123", "code")}) [@Paperclip App](${buildProjectMentionHref("project-456", "#336699")}) [/release-changelog](${buildSkillMentionHref("skill-789", "release-changelog")})`}
          </MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('href="/agents/agent-123"');
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain("--paperclip-mention-icon-mask");
    expect(html).toContain('href="/projects/project-456"');
    expect(html).toContain('data-mention-kind="project"');
    expect(html).toContain("--paperclip-mention-project-color:#336699");
    expect(html).toContain('href="/skills/skill-789"');
    expect(html).toContain('data-mention-kind="skill"');
  });

  it("uses soft-break styling by default", () => {
    const html = renderMarkdown("First line\nSecond line");

    expect(html).toContain("First line<br/>");
    expect(html).toContain("Second line");
  });

  it("can opt out of soft-break styling", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody softBreaks={false}>
            {"First line\nSecond line"}
          </MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).not.toContain("<br/>");
  });

  it("does not inject extra line-break nodes into nested lists", () => {
    const html = renderMarkdown("1. Parent item\n   - child a\n   - child b\n\n2. Second item");

    expect(html).not.toContain("[&amp;_p]:whitespace-pre-line");
    expect(html).not.toContain("Parent item<br/>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
  });

  it("linkifies bare issue identifiers in markdown text", () => {
    const html = renderMarkdown("Depends on PAP-1271 for the hover state.", [
      { identifier: "PAP-1271", status: "done" },
    ]);

    expect(html).toContain('href="/issues/PAP-1271"');
    expect(html).toContain("text-green-600");
    expect(html).toContain(">PAP-1271<");
  });

  it("rewrites full issue URLs to internal issue links", () => {
    const html = renderMarkdown("See http://localhost:3100/PAP/issues/PAP-1179.", [
      { identifier: "PAP-1179", status: "blocked" },
    ]);

    expect(html).toContain('href="/issues/PAP-1179"');
    expect(html).toContain("text-red-600");
    expect(html).toContain(">http://localhost:3100/PAP/issues/PAP-1179<");
  });

  it("linkifies issue identifiers inside inline code spans", () => {
    const html = renderMarkdown("Reference `PAP-1271` here.", [
      { identifier: "PAP-1271", status: "done" },
    ]);

    expect(html).toContain('href="/issues/PAP-1271"');
    expect(html).toContain("<code>PAP-1271</code>");
    expect(html).toContain("text-green-600");
  });

  it("can opt out of issue reference linkification for offline previews", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody linkIssueReferences={false}>
            {"Depends on PAP-1271 and [manual link](PAP-1271)."}
          </MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).not.toContain('href="/issues/PAP-1271"');
    expect(html).toContain("Depends on PAP-1271");
    expect(html).toContain('href="PAP-1271"');
  });
});
