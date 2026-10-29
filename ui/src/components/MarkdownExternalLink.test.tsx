// @vitest-environment node

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { CoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { CoordinatorChatReferences } from "./coordinator/CoordinatorChatReferences";

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

function render(children: string, externalReferences?: MarkdownExternalReferenceMap, coordinator = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CoordinatorPresentation.Provider value={coordinator}>
        <CoordinatorChatReferences.Provider value={new Map(coordinator ? [["tes-2", { label: "Chat with CTD", href: "/chats/ctd" }]] : [])}>
        <MarkdownBody externalReferences={externalReferences}>{children}</MarkdownBody>
        </CoordinatorChatReferences.Provider>
        </CoordinatorPresentation.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("MarkdownBody external object decoration", () => {
  it("labels a standing conversation by its agent and keeps its conversation anchor", () => {
    const html = render("Source: [TES-2](/TES/issues/TES-2#interaction-answer)", undefined, true);
    expect(html).toContain('href="/chats/ctd#interaction-answer"');
    expect(html).toContain('data-mention-kind="chat"');
    expect(html).toContain("Chat with CTD");
    expect(html).not.toContain("Issue TES-2");
    expect(html).not.toContain('data-mention-kind="issue"');
    expect(render("Source: TES-2")).toContain('data-mention-kind="issue"');
  });

  it("uses a compact document card for sidebar links, preserving the exact revision", () => {
    const markdown = "[View saved recommendations](/TES/issues/TES-6#document-skill-recommendations&revision=reviewed-rev)";
    const html = render(markdown, undefined, true);
    expect(html).toContain('data-sidebar-document-link="true"');
    expect(html).toContain('href="/issues/TES-6#document-skill-recommendations&amp;revision=reviewed-rev"');
    expect(html).toContain("View saved recommendations");
    expect(html).not.toContain('data-mention-kind="issue"');
    expect(render(markdown)).not.toContain("data-sidebar-document-link");
    expect(render("[External document](https://example.com/issues/TES-6#document-plan)", undefined, true)).not.toContain("data-sidebar-document-link");
  });
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

  it("labels detected-but-unresolved GitHub objects as not yet refreshed, not not yet resolved", () => {
    const html = render("See https://github.com/acme/web/pull/241", {
      "https://github.com/acme/web/pull/241": {
        providerKey: "github",
        objectType: "pull_request",
        displayKey: "Github Pull Request",
        iconKey: "github",
        statusCategory: "unknown",
        liveness: "unknown",
        statusLabel: null,
        displayTitle: "acme/web#241",
      },
    });
    expect(html).toContain("data-external-link=\"resolved\"");
    expect(html).toContain('aria-label="Github Pull Request Not yet refreshed: acme/web#241"');
    expect(html).not.toContain("Not yet resolved");
  });

  it("does not repeat the liveness label when the status label equals it", () => {
    const html = render("Auth-blocked: https://github.com/acme/web/pull/241", {
      "https://github.com/acme/web/pull/241": {
        providerKey: "github",
        objectType: "pull_request",
        displayKey: "Github Pull Request",
        iconKey: "github",
        statusCategory: "unknown",
        liveness: "auth_required",
        statusLabel: null,
        displayTitle: "acme/web#241",
      },
    });
    expect(html).toContain('aria-label="Github Pull Request Requires auth: acme/web#241"');
    expect(html).not.toContain("Requires auth (Requires auth)");
    expect(html).not.toContain("(Requires auth)");
  });

  it("does not repeat the liveness label when the status label equals it for unreachable", () => {
    const html = render("Down: https://github.com/acme/web/pull/241", {
      "https://github.com/acme/web/pull/241": {
        providerKey: "github",
        objectType: "pull_request",
        displayKey: "Github Pull Request",
        iconKey: "github",
        statusCategory: "unknown",
        liveness: "unreachable",
        statusLabel: null,
        displayTitle: "acme/web#241",
      },
    });
    expect(html).toContain('aria-label="Github Pull Request Unreachable: acme/web#241"');
    expect(html).not.toContain("(Unreachable)");
  });
});
