// @vitest-environment node

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";

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
  issuesApi: { get: vi.fn() },
}));

function render(children: string, externalReferences?: MarkdownExternalReferenceMap) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MarkdownBody externalReferences={externalReferences}>{children}</MarkdownBody>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("MarkdownBody external object decoration", () => {
  const successReference: MarkdownExternalReferenceMap = {
    "https://github.com/acme/web/pull/241": {
      providerKey: "github",
      objectType: "pull_request",
      displayKey: "Github Pull Request",
      iconKey: "github",
      statusCategory: "succeeded",
      statusIconKey: "git-merge",
      liveness: "fresh",
      statusLabel: "Merged",
      displayTitle: "Add external refs",
    },
  };

  it("decorates a known URL with the external status icon and metadata attributes", () => {
    const html = render("Take a look: https://github.com/acme/web/pull/241", successReference);
    expect(html).toContain('class="paperclip-markdown-external-ref"');
    expect(html).toContain('data-external-link="resolved"');
    expect(html).toContain('data-external-status="succeeded"');
    expect(html).toContain('data-external-liveness="fresh"');
    expect(html).toContain('aria-label="Github Pull Request Merged: Add external refs"');
    expect(html).toContain("github.com/acme/web/pull/241");
  });

  it("matches a URL even when the user pasted it with different host case or trailing punctuation", () => {
    const html = render("see HTTPS://Github.com/acme/web/pull/241#frag.", successReference);
    expect(html).toContain('data-external-status="succeeded"');
  });

  it("renders an unresolved URL as a plain external link with no status affordance", () => {
    const html = render("https://random.example.com/path");
    expect(html).not.toContain("paperclip-markdown-external-ref");
    expect(html).toContain('href="https://random.example.com/path"');
  });

  it("never decorates a URL that lives inside a fenced or inline code block", () => {
    const html = render(
      "```\nhttps://github.com/acme/web/pull/241\n```\n\nInline: `https://github.com/acme/web/pull/241`",
      successReference,
    );
    // The fenced/inline literal should still be present as text but the
    // decorated anchor should not appear since no `<a>` is created in code.
    expect(html).not.toContain('class="paperclip-markdown-external-ref"');
  });

  it("shows liveness suffix in the aria-label when the object is stale or auth_required", () => {
    const html = render("Auth-blocked: https://app.hubspot.com/leads/99", {
      "https://app.hubspot.com/leads/99": {
        providerKey: "hubspot",
        objectType: "lead",
        statusCategory: "auth_required",
        liveness: "auth_required",
        statusLabel: "Reconnect",
        displayTitle: "Acme deal",
      },
    });
    expect(html).toContain('aria-label="HubSpot Reconnect (Requires auth): Acme deal"');
  });
});
