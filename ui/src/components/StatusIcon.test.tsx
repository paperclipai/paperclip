// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      const dict: Record<string, string | ((opts?: any) => string)> = {
        "issues.blockerAttention.blocked": "Blocked",
        "issues.blockerAttention.waitingOnActiveSubIssue": (opts) => `Blocked · waiting on active sub-issue ${opts.identifier}`,
        "issues.blockerAttention.waitingOnOneActiveSubIssue": "Blocked · waiting on one active sub-issue",
        "issues.blockerAttention.waitingOnManyActiveSubIssues": (opts) => `Blocked · waiting on active sub-issues ${opts.count}`,
        "issues.blockerAttention.coveredByActiveDependency": (opts) => `Blocked · covered by active dependency ${opts.identifier}`,
        "issues.blockerAttention.coveredByOneActiveDependency": "Blocked · covered by one active dependency",
        "issues.blockerAttention.coveredByManyActiveDependencies": (opts) => `Blocked · covered by ${opts.count} active dependencies`,
        "issues.blockerAttention.reviewStalledOn": (opts) => `Blocked · review stalled on ${opts.leaf}`,
        "issues.blockerAttention.reviewStalledNoStep": "Blocked · review stalled",
        "issues.blockerAttention.reviewsStalledNoStep": (opts) => `Blocked · reviews stalled ${opts.count}`,
        "issues.blockerAttention.needsAttentionOne": "1 blocker needs attention",
        "issues.blockerAttention.needsAttentionMany": (opts) => `${opts.count} blockers need attention`,
        "issues.blockerAttention.attentionWithCovered": (opts) => `Blocked · ${opts.attention}; ${opts.covered} covered by active work`,
        "issues.blockerAttention.attentionOnly": (opts) => `Blocked · ${opts.attention}`,
      };

      const val = dict[key];
      if (typeof val === "function") {
        return val(options);
      }
      return val ?? options?.defaultValue ?? key;
    },
  }),
}));

describe("StatusIcon", () => {
  it("renders covered blocked issues with the cyan covered state visual", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "covered",
          reason: "active_child",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2",
          sampleStalledBlockerIdentifier: null,
        }}
      />,
    );

    expect(html).toContain('data-blocker-attention-state="covered"');
    expect(html).toContain('aria-label="Blocked · waiting on active sub-issue PAP-2"');
    expect(html).toContain('title="Blocked · waiting on active sub-issue PAP-2"');
    expect(html).toContain("border-cyan-600");
    expect(html).not.toContain("border-red-600");
    expect(html).not.toContain("border-dashed");
    expect(html).toContain("-bottom-0.5");
  });

  it("uses covered blocked copy for the active dependency count matrix", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 2,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: null,
          sampleStalledBlockerIdentifier: null,
        }}
      />,
    );

    expect(html).toContain('aria-label="Blocked · covered by 2 active dependencies"');
    expect(html).toContain("border-cyan-600");
    expect(html).not.toContain("border-dashed");
  });

  it("keeps normal blocked issues on the attention-required visual", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 0,
          stalledBlockerCount: 0,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: "PAP-2",
          sampleStalledBlockerIdentifier: null,
        }}
      />,
    );

    expect(html).not.toContain('data-blocker-attention-state="covered"');
    expect(html).toContain('data-blocker-attention-state="needs_attention"');
    expect(html).toContain('aria-label="Blocked · 1 blocker needs attention"');
    expect(html).toContain("border-red-600");
    expect(html).not.toContain("border-dashed");
  });

  it("shows active covered work on mixed attention-required blockers", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 5,
          coveredBlockerCount: 2,
          stalledBlockerCount: 0,
          attentionBlockerCount: 3,
          sampleBlockerIdentifier: "PAP-3541",
          sampleStalledBlockerIdentifier: null,
        }}
      />,
    );

    expect(html).toContain('data-blocker-attention-state="needs_attention"');
    expect(html).toContain('aria-label="Blocked · 3 blockers need attention; 2 covered by active work"');
    expect(html).toContain("border-red-600");
    expect(html).not.toContain("border-cyan-600");
    expect(html).toContain("bg-cyan-600");
  });

  it("renders stalled review chains with amber visual and stalled-leaf copy", () => {
    const html = renderToStaticMarkup(
      <StatusIcon
        status="blocked"
        blockerAttention={{
          state: "stalled",
          reason: "stalled_review",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 0,
          stalledBlockerCount: 1,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2279",
          sampleStalledBlockerIdentifier: "PAP-2279",
        }}
      />,
    );

    expect(html).toContain('data-blocker-attention-state="stalled"');
    expect(html).toContain('aria-label="Blocked · review stalled on PAP-2279"');
    expect(html).toContain("border-amber-600");
    expect(html).not.toContain("border-cyan-600");
    expect(html).not.toContain("border-red-600");
  });
});
