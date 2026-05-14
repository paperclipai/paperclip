// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusIcon } from "./StatusIcon";

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
    expect(html).toContain('aria-label="阻塞 · 等待活跃子事务 PAP-2"');
    expect(html).toContain('title="阻塞 · 等待活跃子事务 PAP-2"');
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

    expect(html).toContain('aria-label="阻塞 · 由 2 个活跃依赖覆盖"');
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
    expect(html).toContain('aria-label="阻塞 · 1 个阻塞项需要处理"');
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
    expect(html).toContain('aria-label="阻塞 · 3 个阻塞项需要处理；2 个已由活跃工作覆盖"');
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
    expect(html).toContain('aria-label="阻塞 · 审查停滞于 PAP-2279"');
    expect(html).toContain("border-amber-600");
    expect(html).not.toContain("border-cyan-600");
    expect(html).not.toContain("border-red-600");
  });
});
