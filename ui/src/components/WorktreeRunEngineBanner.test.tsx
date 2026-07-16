// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeRunEngineStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeRunEngineBanner } from "./WorktreeRunEngineBanner";

function render(status: WorktreeRunEngineStatus | undefined, variant: "strip" | "detail" = "detail") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <WorktreeRunEngineBanner variant={variant} status={status} />
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

function armed(overrides: Partial<WorktreeRunEngineStatus> = {}): WorktreeRunEngineStatus {
  return {
    inWorktree: true,
    activation: {
      armed: true,
      cutoff: "2026-07-10T18:34:00.000Z",
      activationInstanceId: "nonce-aaaaaaaa1111",
      instanceNonce: "nonce-aaaaaaaa1111",
      seedEpoch: "epoch-bbbbbbbb2222",
      reason: null,
    },
    instanceNonce: "nonce-aaaaaaaa1111",
    quarantinedRunCount: 0,
    ...overrides,
  };
}

function suppressed(
  reason: Extract<WorktreeRunEngineStatus["activation"], { armed: false }>["reason"],
  overrides: Partial<WorktreeRunEngineStatus> = {},
): WorktreeRunEngineStatus {
  return {
    inWorktree: true,
    activation: {
      armed: false,
      cutoff: null,
      activationInstanceId: reason === "instance_id_mismatch" ? "nonce-oldoldold9999" : null,
      reason,
    },
    instanceNonce: "nonce-current0000",
    quarantinedRunCount: 0,
    ...overrides,
  };
}

describe("WorktreeRunEngineBanner", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(() => {
    flushSync(() => {
      roots.forEach((root) => root.unmount());
    });
    document.body.innerHTML = "";
  });

  function mount(status: WorktreeRunEngineStatus | undefined, variant: "strip" | "detail" = "detail") {
    const { container, root } = render(status, variant);
    roots.push(root);
    return container;
  }

  it("renders nothing outside a worktree runtime", () => {
    const container = mount({
      inWorktree: false,
      activation: { armed: false, cutoff: null, activationInstanceId: null, reason: "not_worktree_runtime" },
      instanceNonce: null,
      quarantinedRunCount: 0,
    });
    expect(container.textContent).toBe("");
  });

  it("renders nothing while the query has no data", () => {
    const container = mount(undefined);
    expect(container.textContent).toBe("");
  });

  it("shows the armed cutoff and a matching identity when armed", () => {
    const container = mount(armed({ quarantinedRunCount: 3 }));
    expect(container.textContent).toContain("Run engine armed since");
    expect(container.textContent).toContain("matches");
    expect(container.textContent).not.toContain("mismatch");
    expect(container.textContent).toContain("3 inherited runs were quarantined");
  });

  it("reads an identity mismatch as bound to another instance", () => {
    const container = mount(suppressed("instance_id_mismatch"));
    expect(container.textContent).toContain("bound to another instance");
    expect(container.textContent).toContain("mismatch");
    // Both identities are surfaced so the mismatch is legible.
    expect(container.textContent).toContain("nonce-ol");
    expect(container.textContent).toContain("nonce-cu");
  });

  it("explains a missing activation cutoff", () => {
    const container = mount(suppressed("missing_cutoff"));
    expect(container.textContent).toContain("missing activation cutoff");
    expect(container.textContent).toContain("Toggle it off and back on");
  });

  it("explains a flag-disabled run engine", () => {
    const container = mount(suppressed("flag_disabled"));
    expect(container.textContent).toContain("Run engine off");
  });

  it("renders a dense single-line strip variant", () => {
    const container = mount(armed(), "strip");
    const strip = container.querySelector('[data-testid="worktree-run-engine-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Run engine");
    expect(strip?.textContent).toContain("armed since");
  });

  it("surfaces quarantined counts in the strip when suppressed", () => {
    const container = mount(suppressed("flag_disabled", { quarantinedRunCount: 5 }), "strip");
    const strip = container.querySelector('[data-testid="worktree-run-engine-strip"]');
    expect(strip?.textContent).toContain("5 inherited runs inactive");
  });

  // PAP-14415: the strip supplies its own bold "Run engine" subject, so the
  // suppressed predicate must not restate it (no "Run engine run engine off").
  it("does not stutter the run-engine subject in the suppressed strip", () => {
    const container = mount(suppressed("flag_disabled", { quarantinedRunCount: 4 }), "strip");
    const text = container
      .querySelector('[data-testid="worktree-run-engine-strip"]')
      ?.textContent?.replace(/\s+/g, " ");
    expect(text).toContain("Run engine off");
    expect(text).not.toMatch(/run engine run engine/i);
  });

  it("uses a bare predicate for a mismatched-identity strip", () => {
    const container = mount(suppressed("instance_id_mismatch"), "strip");
    const text = container
      .querySelector('[data-testid="worktree-run-engine-strip"]')
      ?.textContent?.replace(/\s+/g, " ");
    expect(text).toContain("Run engine inactive — bound to another instance");
    expect(text).not.toMatch(/run engine toggle inactive/i);
  });
});
