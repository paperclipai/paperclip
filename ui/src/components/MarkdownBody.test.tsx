// @vitest-environment node

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAgentMentionHref,
  buildIssueReferenceHref,
  buildProjectMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
} from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

function renderMarkdown(children: string, seededIssues: Array<{ identifier: string; status: string; title?: string }> = []) {
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
      title: issue.title,
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

  it("renders user, agent, project, and skill mentions as chips", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody>
            {`[@Taylor](${buildUserMentionHref("user-123")}) [@CodexCoder](${buildAgentMentionHref("agent-123", "code")}) [@Paperclip App](${buildProjectMentionHref("project-456", "#336699")}) [/release-changelog](${buildSkillMentionHref("skill-789", "release-changelog")})`}
          </MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('href="/company/settings/access"');
    expect(html).toContain('data-mention-kind="user"');
    expect(html).toContain('href="/agents/agent-123"');
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain("--paperclip-mention-icon-mask");
    expect(html).toContain('href="/projects/project-456"');
    expect(html).toContain('data-mention-kind="project"');
    expect(html).toContain("--paperclip-mention-project-color:#336699");
    expect(html).toContain('href="/skills/skill-789"');
    expect(html).toContain('data-mention-kind="skill"');
  });

  it("sanitizes unsafe javascript markdown links", () => {
    const html = renderMarkdown("[click me](javascript:alert(document.cookie))");

    expect(html).toContain('<a href="" rel="noreferrer"');
    expect(html).toContain(">click me</a>");
    expect(html).not.toContain("javascript:");
  });

  it("renders raw HTML tags as escaped text", () => {
    const html = renderMarkdown(
      '<script>fetch("/api/secrets")</script>\n<iframe src="https://example.com"></iframe>\n<p onclick="steal()">Plain text</p>',
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<p onclick");
    expect(html).not.toContain('onclick="steal()"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("onclick=&quot;steal()&quot;");
    expect(html).toContain("Plain text");
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
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain("paperclip-markdown-issue-ref");
    expect(html).not.toContain("paperclip-mention-chip--issue");
  });

  it("uses concise issue aria labels until a distinct title is available", () => {
    const html = renderMarkdown("Depends on PAP-1271 and PAP-1272.", [
      { identifier: "PAP-1271", status: "done" },
      { identifier: "PAP-1272", status: "blocked", title: "Fix hover state" },
    ]);

    expect(html).toContain('aria-label="Issue PAP-1271"');
    expect(html).toContain('aria-label="Issue PAP-1272: Fix hover state"');
    expect(html).not.toContain('aria-label="Issue PAP-1271: PAP-1271"');
  });

  it("rewrites full issue URLs to internal issue links", () => {
    const html = renderMarkdown("See http://localhost:3100/PAP/issues/PAP-1179.", [
      { identifier: "PAP-1179", status: "blocked" },
    ]);

    expect(html).toContain('href="/issues/PAP-1179"');
    expect(html).toContain("text-red-600");
    expect(html).toContain(">http://localhost:3100/PAP/issues/PAP-1179<");
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).not.toContain("paperclip-mention-chip--issue");
  });

  it("linkifies plain internal issue paths in markdown text", () => {
    const html = renderMarkdown("See /issues/PAP-1179 and /PAP/issues/pap-1180 for context.", [
      { identifier: "PAP-1179", status: "blocked" },
      { identifier: "PAP-1180", status: "done" },
    ]);

    expect(html).toContain('href="/issues/PAP-1179"');
    expect(html).toContain('href="/issues/PAP-1180"');
    expect(html).toContain(">/issues/PAP-1179<");
    expect(html).toContain(">/PAP/issues/pap-1180<");
    expect(html).toContain("text-red-600");
    expect(html).toContain("text-green-600");
  });

  it("does not auto-link non-issue internal route paths", () => {
    const html = renderMarkdown("Use /issues/new for the creation form, /issues/PAP-42extra as text, and /api/issues for data.");

    expect(html).toContain("Use /issues/new for the creation form, /issues/PAP-42extra as text, and /api/issues for data.");
    expect(html).not.toContain('href="/issues/new"');
    expect(html).not.toContain('href="/issues/PAP-42"');
    expect(html).not.toContain('data-mention-kind="issue"');
  });

  it("rewrites issue scheme links to internal issue links", () => {
    const html = renderMarkdown("See issue://PAP-1310 and issue://:PAP-1311.", [
      { identifier: "PAP-1310", status: "done" },
      { identifier: "PAP-1311", status: "blocked" },
    ]);

    expect(html).toContain('href="/issues/PAP-1310"');
    expect(html).toContain('href="/issues/PAP-1311"');
    expect(html).toContain(">issue://PAP-1310<");
    expect(html).toContain(">issue://:PAP-1311<");
    expect(html).toContain("text-green-600");
    expect(html).toContain("text-red-600");
  });

  it("linkifies issue identifiers inside inline code spans", () => {
    const html = renderMarkdown("Reference `PAP-1271` here.", [
      { identifier: "PAP-1271", status: "done" },
    ]);

    expect(html).toContain('href="/issues/PAP-1271"');
    expect(html).toContain('<code style="overflow-wrap:anywhere;word-break:break-word">PAP-1271</code>');
    expect(html).toContain("text-green-600");
    expect(html).toContain("paperclip-markdown-issue-ref");
  });

  it("keeps trailing punctuation outside auto-linked issue references", () => {
    const html = renderMarkdown("See PAP-1271: /issues/PAP-1272] and issue://PAP-1273.", [
      { identifier: "PAP-1271", status: "done" },
      { identifier: "PAP-1272", status: "blocked" },
      { identifier: "PAP-1273", status: "todo" },
    ]);

    expect(html).toContain('<a href="/issues/PAP-1271"');
    expect(html).toContain('>PAP-1271</a>:');
    expect(html).toContain('<a href="/issues/PAP-1272"');
    expect(html).toContain('>/issues/PAP-1272</a>]');
    expect(html).toContain('<a href="/issues/PAP-1273"');
    expect(html).toContain('>issue://PAP-1273</a>.');
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

  it("applies wrap-friendly styles to long inline content", () => {
    const html = renderMarkdown("averyveryveryveryveryveryveryveryveryverylongtoken");

    expect(html).toContain('class="paperclip-markdown prose prose-sm min-w-0 max-w-full break-words overflow-hidden');
    expect(html).toContain('style="overflow-wrap:anywhere;word-break:break-word"');
    expect(html).toContain("<p");
  });

  it("applies wrap-friendly styles to long links", () => {
    const html = renderMarkdown("[link](https://example.com/reallyreallyreallyreallyreallyreallyreallyreallylong)");

    expect(html).toContain('<a href="https://example.com/reallyreallyreallyreallyreallyreallyreallyreallylong"');
    expect(html).toContain('style="overflow-wrap:anywhere;word-break:break-word"');
  });

  it("opens external links in a new tab with safe rel attributes", () => {
    const html = renderMarkdown("[docs](https://example.com/docs)");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("opens GitHub links in a new tab", () => {
    const html = renderMarkdown("[pr](https://github.com/paperclipai/paperclip/pull/4099)");

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not set target on relative internal links", () => {
    const html = renderMarkdown("[settings](/company/settings)");

    expect(html).toContain('href="/company/settings"');
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("prefixes GitHub markdown links with the GitHub icon glued to the first character", () => {
    const html = renderMarkdown("[https://github.com/paperclipai/paperclip/pull/4099](https://github.com/paperclipai/paperclip/pull/4099)");

    expect(html).toContain('<a href="https://github.com/paperclipai/paperclip/pull/4099"');
    expect(html).toContain('class="lucide lucide-github mr-1 inline h-3.5 w-3.5 align-[-0.125em]"');
    // The icon and first character "h" must sit in a no-wrap span so the
    // icon can never be orphaned on the previous line from the URL text.
    expect(html).toMatch(/<span style="white-space:nowrap">.*lucide-github.*?<\/svg>h<\/span>/);
    expect(html).toContain("ttps://github.com/paperclipai/paperclip/pull/4099");
    expect(html).not.toContain("lucide-external-link");
  });

  it("prefixes GitHub autolinks with the GitHub icon", () => {
    const html = renderMarkdown("See https://github.com/paperclipai/paperclip/issues/1778");

    expect(html).toContain('<a href="https://github.com/paperclipai/paperclip/issues/1778"');
    expect(html).toContain('class="lucide lucide-github mr-1 inline h-3.5 w-3.5 align-[-0.125em]"');
  });

  it("does not prefix non-GitHub markdown links with the GitHub icon", () => {
    const html = renderMarkdown("[docs](https://example.com/docs)");

    expect(html).toContain('<a href="https://example.com/docs"');
    expect(html).not.toContain("lucide-github");
  });

  it("suffixes external links with a new-tab icon glued to the last character", () => {
    const html = renderMarkdown("[docs](https://example.com/docs)");

    expect(html).toContain('target="_blank"');
    expect(html).toContain("lucide-external-link");
    // Last character "s" must sit in a no-wrap span with the icon so the
    // indicator never wraps away from the link text.
    expect(html).toMatch(/<span style="white-space:nowrap">s<svg[^>]*lucide-external-link/);
  });

  it("does not render the new-tab icon on internal links", () => {
    const html = renderMarkdown("[settings](/company/settings)");

    expect(html).not.toContain("lucide-external-link");
  });

  it("keeps fenced code blocks width-bounded and horizontally scrollable", () => {
    const html = renderMarkdown("```text\nGET /heartbeat-runs/ca5d23fc-c15b-4826-8ff1-2b6dd11be096/log?offset=2062357&limitBytes=256000\n```");

    expect(html).toContain("<pre");
    expect(html).toContain('style="max-width:100%;overflow-x:auto"');
  });

  it("renders internal issue links and bare identifiers as inline issue refs", () => {
    const html = renderMarkdown(`See PAP-42 and [linked task](${buildIssueReferenceHref("PAP-77")}) for follow-up.`, [
      { identifier: "PAP-42", status: "done" },
      { identifier: "PAP-77", status: "blocked" },
    ]);

    expect(html).toContain('href="/issues/PAP-42"');
    expect(html).toContain('href="/issues/PAP-77"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain("paperclip-markdown-issue-ref");
    expect(html).not.toContain("paperclip-mention-chip--issue");
  });
});
