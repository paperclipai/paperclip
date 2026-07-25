// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionCard, ActionCardMobile, BindingsTable, shortSha } from "./ActionCard";

// EnforcementBanner pulls in a react-query hook; the stale variant only needs
// its presentational copy, so stub it to keep the test free of a QueryClient.
vi.mock("@/components/EnforcementBanner", () => ({
  EnforcementBanner: ({ title, body }: { title?: string; body?: string }) => (
    <div data-testid="stale-banner">
      <span>{title}</span>
      <span>{body}</span>
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root?.render(element));
  return container;
}

const baseBinding = {
  application: "Slack",
  manifestVersion: "2.4.1",
  connection: "https://slack.com/api",
  catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
};

const baseProps = {
  toolName: "slack.post_message",
  risk: "medium" as const,
  isWrite: true,
  binding: baseBinding,
  input: { channel: "#launch", text: "hi" },
  reason: "Write-capable tool.",
  policyNumber: 7,
  expiresInLabel: "expires in 23h 51m",
};

function approveButton(c: HTMLElement): HTMLButtonElement {
  const btn = Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Approve");
  if (!btn) throw new Error("Approve button not found");
  return btn as HTMLButtonElement;
}

describe("ActionCard", () => {
  it("surfaces the signed payload sha256 and expiry (PAP-10400)", () => {
    const c = render(<ActionCard {...baseProps} />);
    expect(c.textContent).toContain(shortSha(baseBinding.payloadSha256));
    expect(c.textContent).toContain("signed");
    expect(c.textContent).toContain("expires in 23h 51m");
  });

  it("references the policy number in the explanation", () => {
    const c = render(<ActionCard {...baseProps} />);
    expect(c.textContent).toContain("Policy #7");
  });

  it("enables Approve on the pending variant and fires the handler", () => {
    const onApprove = vi.fn();
    const c = render(<ActionCard {...baseProps} onApprove={onApprove} />);
    const btn = approveButton(c);
    expect(btn.disabled).toBe(false);
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("disables Approve and shows the catalog mismatch on the stale variant", () => {
    const c = render(
      <ActionCard
        {...baseProps}
        variant="stale"
        binding={{
          ...baseBinding,
          catalogSha256: "sha256:7d793037a0760186574b0282f2f435e7deadbeefcafef00dba5eba5eba5eba5e",
          previousCatalogSha256: baseBinding.catalogSha256,
        }}
      />,
    );
    expect(approveButton(c).disabled).toBe(true);
    expect(c.querySelector('[data-testid="stale-banner"]')).not.toBeNull();
    // Previous (now-invalid) hash is struck through next to the current one.
    const struck = c.querySelector(".line-through");
    expect(struck?.textContent).toContain(shortSha(baseBinding.catalogSha256));
  });

  it("stacks buttons Approve / Deny / Edit & re-sign on mobile with a 70px label column", () => {
    const c = render(<ActionCardMobile {...baseProps} />);
    const labels = c.querySelectorAll("dt");
    expect(labels.length).toBeGreaterThan(0);
    expect((labels[0] as HTMLElement).style.width).toBe("70px");

    const buttonText = Array.from(c.querySelectorAll("button")).map((b) => b.textContent?.trim());
    const order = buttonText.filter((t) => t === "Approve" || t === "Deny" || t?.startsWith("Edit"));
    expect(order[0]).toBe("Approve");
    expect(order[1]).toBe("Deny");
    expect(order[2]).toContain("Edit");
  });
});

describe("BindingsTable", () => {
  it("renders mono rows with the default 132px label column", () => {
    const c = render(
      <BindingsTable rows={[{ label: "Catalog", value: "sha256:abc", mono: true }]} />,
    );
    const dt = c.querySelector("dt") as HTMLElement;
    expect(dt.style.width).toBe("132px");
    expect(c.querySelector("dd")?.className).toContain("font-mono");
  });
});

describe("shortSha", () => {
  it("truncates a long sha to the review form", () => {
    expect(shortSha("sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe(
      "sha256:9f86d08188…f00a08",
    );
  });
  it("leaves a short sha intact", () => {
    expect(shortSha("sha256:abcd")).toBe("sha256:abcd");
  });
});
