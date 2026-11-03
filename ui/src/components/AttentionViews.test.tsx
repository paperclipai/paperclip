// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionAudience, AttentionItem, AttentionReceipt } from "@paperclipai/shared";
import type { AnchorHTMLAttributes } from "react";
import { AttentionAudienceLine, AttentionReceiptList, AttentionUnassignedBanner, AttentionViewSwitch } from "./AttentionViews";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, disableIssueQuicklook: _quicklook, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; disableIssueQuicklook?: boolean }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const card = (audience: AttentionAudience) =>
  ({ id: "card", sourceKind: "issue_thread_interaction", audience, subject: { id: "interaction-1", title: "Approve the plan" } }) as unknown as AttentionItem;
const labels = new Map([["dotta", "Dotta"]]);

describe("AttentionViewSwitch", () => {
  it("shows the For you badge and the Unassigned and Company counts on their own tabs", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<AttentionViewSwitch value="mine" counts={{ mine: 4, unassigned: 3, company: 2, archived: 5, all: 9 }} onChange={onChange} />));
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["For you4", "Unassigned3", "Company2", "Archived5"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-attention-view-count="mine"]')?.getAttribute("data-slot")).toBe("badge");
    const unassigned = container.querySelector<HTMLElement>('[data-attention-view="unassigned"]')!;
    await act(async () => {
      unassigned.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      unassigned.focus();
    });
    expect(onChange).toHaveBeenCalledWith("unassigned");
  });

  it("shows Everyone with its own count only to a board member, never as the badge (PAP-768)", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<AttentionViewSwitch value="all" counts={{ mine: 4, unassigned: 3, company: 2, archived: 5, all: 9 }} onChange={onChange} everyone />));
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["For you4", "Unassigned3", "Company2", "Archived5", "Everyone9"]);
    expect(tabs[4]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-attention-view-count="all"]')?.getAttribute("data-slot")).not.toBe("badge");
    const mine = container.querySelector<HTMLElement>('[data-attention-view="mine"]')!;
    await act(async () => {
      mine.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      mine.focus();
    });
    expect(onChange).toHaveBeenCalledWith("mine");
  });

  it("leaves Everyone out for a person who is not a board member (PAP-768)", async () => {
    await act(async () => root.render(<AttentionViewSwitch value="mine" counts={{ mine: 4, unassigned: 3, company: 2, archived: 5, all: 9 }} onChange={() => {}} />));
    expect(container.querySelector('[data-attention-view="all"]')).toBeNull();
  });

  it("hides an empty For you badge", async () => {
    await act(async () => root.render(<AttentionViewSwitch value="mine" counts={{ mine: 0, unassigned: 1, company: 0, archived: 0, all: 1 }} onChange={() => {}} />));
    expect(container.querySelector('[data-attention-view-count="mine"]')).toBeNull();
  });
});

describe("AttentionUnassignedBanner", () => {
  it("says how many cards need an owner and opens Unassigned", async () => {
    const onOpen = vi.fn();
    await act(async () => root.render(<AttentionUnassignedBanner count={3} onOpen={onOpen} />));
    expect(container.textContent).toContain("3 cards need an owner");
    await act(async () => container.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the pool is empty", async () => {
    await act(async () => root.render(<AttentionUnassignedBanner count={0} onOpen={() => {}} />));
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
  });
});

describe("AttentionAudienceLine", () => {
  it("points an ownerless card Claim cannot take to its task, or says it cannot be claimed (PAP-767)", async () => {
    const pool: AttentionAudience = { kind: "pool", userId: null, reason: "none" };
    // NEE-16: a blocked task with no human; its owner is whoever the task is assigned to.
    const blocker = { ...card(pool), sourceKind: "blocker_attention", subject: { id: "issue-16", kind: "issue", title: "Run recovery", href: "/NEE/issues/NEE-16" } } as unknown as AttentionItem;
    await act(async () => root.render(<AttentionAudienceLine item={blocker} currentUserId="scott" onClaim={() => {}} />));
    const assign = container.querySelector<HTMLAnchorElement>("[data-attention-open-to-assign]");
    expect(assign?.textContent).toBe("Open to assign");
    expect(assign?.getAttribute("href")).toBe("/NEE/issues/NEE-16");
    expect(container.textContent).not.toContain("Claim");

    // The budget override approval has no task to assign.
    const approval = { ...card(pool), sourceKind: "approval", subject: { id: "approval-1", kind: "approval", title: "budget override required", href: "/NEE/approvals/approval-1" }, relatedIssue: null } as unknown as AttentionItem;
    await act(async () => root.render(<AttentionAudienceLine item={approval} currentUserId="scott" onClaim={() => {}} />));
    expect(container.querySelector("[data-attention-no-claim]")?.textContent).toBe("It has no task to assign, so it can't be claimed.");
    expect(container.querySelector("[data-attention-open-to-assign]")).toBeNull();
  });

  it("answers Why me? on your own card", async () => {
    await act(async () => root.render(<AttentionAudienceLine item={card({ kind: "user", userId: "scott", reason: "reviewer" })} currentUserId="scott" />));
    expect(container.querySelector('[data-attention-audience="mine"]')?.textContent).toBe("Why me?You are the reviewer");
  });

  it("shows For @name on a different person's card, with no Claim", async () => {
    await act(async () => root.render(<AttentionAudienceLine item={card({ kind: "user", userId: "dotta", reason: "addressee" })} currentUserId="scott" userLabelMap={labels} onClaim={() => {}} />));
    expect(container.querySelector("[data-attention-for-user]")?.textContent).toBe("For @Dotta");
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers Claim on an ownerless card and reports the claimed item", async () => {
    const onClaim = vi.fn();
    const pool = card({ kind: "pool", userId: null, reason: "none" });
    await act(async () => root.render(<AttentionAudienceLine item={pool} currentUserId="scott" onClaim={onClaim} />));
    expect(container.textContent).toContain("No owner yet");
    await act(async () => container.querySelector("button")!.click());
    expect(onClaim).toHaveBeenCalledWith(pool);
  });

  it("says who transferred a card to you", async () => {
    const labelsWithScott = new Map([["scott", "Scott"]]);
    await act(async () => root.render(<AttentionAudienceLine item={card({ kind: "user", userId: "riley", reason: "addressee", transferredByUserId: "scott" })} currentUserId="riley" userLabelMap={labelsWithScott} />));
    expect(container.querySelector('[data-attention-audience="mine"]')?.textContent).toBe("Why me?Transferred by @Scott");
  });

  it("stays silent until the viewer is known", async () => {
    await act(async () => root.render(<AttentionAudienceLine item={card({ kind: "user", userId: "scott", reason: "addressee" })} currentUserId={null} />));
    expect(container.innerHTML).toBe("");
  });
});

describe("AttentionReceiptList (PAP-749 plan §6)", () => {
  const receipt = (overrides: Partial<AttentionReceipt> = {}): AttentionReceipt => ({
    id: "activity-1",
    dismissalKey: "attention:receipt:activity-1",
    outcome: "withdrawn",
    sourceKind: "issue_thread_interaction",
    sourceId: "interaction-1",
    title: "Approve the launch plan?",
    reason: "Plan changed",
    actorUserId: "scott",
    transferredToUserId: null,
    issue: { id: "issue-1", identifier: "PAP-1", title: "Launch", href: "/PAP/issues/PAP-1" },
    href: "/PAP/issues/PAP-1#interaction-interaction-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...overrides,
  });
  const people = new Map([["scott", "Scott"], ["riley", "Riley"]]);

  it("says who did what, why, and opens or dismisses the receipt", async () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    const withdrawn = receipt();
    await act(async () => root.render(<AttentionReceiptList receipts={[withdrawn, receipt({ id: "activity-2", outcome: "transferred", reason: null, transferredToUserId: "riley" })]} userLabelMap={people} onDismiss={onDismiss} onOpen={onOpen} />));
    const rows = [...container.querySelectorAll("[data-attention-receipt]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Withdrawn by @Scott");
    expect(rows[0]?.textContent).toContain("Reason: Plan changed");
    expect(rows[0]?.textContent).toContain("PAP-1");
    expect(rows[1]?.textContent).toContain("Transferred to @Riley by @Scott");
    await act(async () => rows[0]!.querySelector<HTMLButtonElement>("button")!.click());
    expect(onOpen).toHaveBeenCalledWith("/PAP/issues/PAP-1#interaction-interaction-1");
    await act(async () => rows[0]!.querySelector<HTMLButtonElement>('[aria-label="Dismiss receipt"]')!.click());
    expect(onDismiss).toHaveBeenCalledWith(withdrawn);
  });

  it("renders nothing without receipts", async () => {
    await act(async () => root.render(<AttentionReceiptList receipts={[]} onDismiss={() => {}} />));
    expect(container.querySelector("[data-attention-receipts]")).toBeNull();
  });
});
