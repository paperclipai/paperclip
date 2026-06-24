// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalObjectPill } from "./ExternalObjectPill";
import { ExternalObjectStatusSummary } from "./ExternalObjectStatusSummary";

describe("ExternalObjectPill", () => {
  it("renders a clickable anchor when a URL is provided", () => {
    const html = renderToStaticMarkup(
      <ExternalObjectPill
        object={{
          providerKey: "github",
          objectType: "pull_request",
          statusCategory: "succeeded",
          liveness: "fresh",
          displayTitle: "Add external refs",
          url: "https://github.com/acme/web/pull/241",
        }}
        sourceCount={4}
        sourceSummary="description, 3 comments"
      />,
    );
    expect(html).toContain('href="https://github.com/acme/web/pull/241"');
    expect(html).toContain('data-mention-kind="external-object"');
    expect(html).toContain('data-external-status="succeeded"');
    expect(html).toContain('data-external-liveness="fresh"');
    expect(html).toContain("×4");
    expect(html).toContain('aria-label="GitHub pull request — Succeeded: Add external refs"');
  });

  it("falls back to a non-interactive span when no URL is supplied", () => {
    const html = renderToStaticMarkup(
      <ExternalObjectPill
        object={{
          providerKey: null,
          objectType: null,
          statusCategory: "unknown",
          liveness: "unknown",
          url: null,
        }}
      />,
    );
    expect(html).toContain('data-mention-kind="external-object"');
    expect(html).not.toContain("<a ");
    expect(html).toContain('aria-label="External object — Not yet resolved"');
  });

  it("applies the dashed-border liveness overlay when stale or auth_required", () => {
    const stale = renderToStaticMarkup(
      <ExternalObjectPill
        object={{
          providerKey: "github",
          objectType: "pull_request",
          statusCategory: "failed",
          liveness: "stale",
          url: "https://github.com/acme/web/pull/242",
        }}
      />,
    );
    expect(stale).toContain("opacity-70");
    expect(stale).toContain("[border-style:dashed]");

    const auth = renderToStaticMarkup(
      <ExternalObjectPill
        object={{
          providerKey: "hubspot",
          objectType: "lead",
          statusCategory: "auth_required",
          liveness: "auth_required",
          url: "https://app.hubspot.com/leads/99",
        }}
      />,
    );
    expect(auth).toContain("[border-style:dashed]");
  });

  it("does not show a source count when only a single mention is present", () => {
    const html = renderToStaticMarkup(
      <ExternalObjectPill
        object={{
          providerKey: "github",
          objectType: "pull_request",
          statusCategory: "succeeded",
          liveness: "fresh",
          url: "https://github.com/acme/web/pull/241",
        }}
        sourceCount={1}
      />,
    );
    expect(html).not.toContain("×");
  });

  it("uses the object link label, provider icon, and visible status when supplied", () => {
    const html = renderToStaticMarkup(
      <ExternalObjectPill
        object={{
          providerKey: "github",
          objectType: "pull_request",
          displayKey: "Github Pull Request",
          iconKey: "github",
          statusCategory: "succeeded",
          statusIconKey: null,
          liveness: "fresh",
          statusLabel: "Merged",
          displayTitle: "acme/web#241: Add rich object presentation metadata",
          url: "https://github.com/acme/web/pull/241",
        }}
      />,
    );
    expect(html).toContain("Merged");
    expect(html).toContain("PR 241 - Merged");
    expect(html).not.toContain("acme/web#241</span>");
    expect(html).toContain("text-violet-600");
    expect(html).not.toContain("Github Pull Request");
    expect(html).toContain('aria-label="GitHub pull request — Merged: acme/web#241: Add rich object presentation metadata"');
  });
});

describe("ExternalObjectStatusSummary", () => {
  it("hides itself when there are no external objects", () => {
    const html = renderToStaticMarkup(<ExternalObjectStatusSummary summary={null} />);
    expect(html).toBe("");
  });

  it("hides itself when the highest severity is muted", () => {
    const html = renderToStaticMarkup(
      <ExternalObjectStatusSummary
        summary={{
          total: 2,
          byStatusCategory: { closed: 2 },
          byLiveness: { fresh: 2 },
          highestSeverity: "muted",
          staleCount: 0,
          authRequiredCount: 0,
          unreachableCount: 0,
          objects: [],
        }}
      />,
    );
    expect(html).toBe("");
  });

  it("shows the dominant-severity icon and count", () => {
    const html = renderToStaticMarkup(
      <ExternalObjectStatusSummary
        summary={{
          total: 5,
          byStatusCategory: { failed: 3, succeeded: 2 },
          byLiveness: { fresh: 5 },
          highestSeverity: "danger",
          staleCount: 0,
          authRequiredCount: 0,
          unreachableCount: 0,
          objects: [
            { id: "a", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed", statusTone: "danger", liveness: "fresh", isTerminal: false },
            { id: "b", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed", statusTone: "danger", liveness: "fresh", isTerminal: false },
            { id: "c", providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed", statusTone: "danger", liveness: "fresh", isTerminal: false },
            { id: "d", providerKey: "github", objectType: "pull_request", displayTitle: null, statusCategory: "succeeded", statusTone: "success", liveness: "fresh", isTerminal: true },
            { id: "e", providerKey: "github", objectType: "pull_request", displayTitle: null, statusCategory: "succeeded", statusTone: "success", liveness: "fresh", isTerminal: true },
          ],
        }}
      />,
    );
    expect(html).toContain('data-external-status="failed"');
    expect(html).toContain('data-external-tone="danger"');
    expect(html).toContain(">3<");
    expect(html).toContain("aria-label=\"External objects: 3 failed, 2 succeeded, 5 total\"");
  });
});
