// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionAudience, AttentionItem } from "@paperclipai/shared";
import { AttentionAudienceLine, AttentionUnassignedBanner, AttentionViewSwitch } from "./AttentionViews";

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
    await act(async () => root.render(<AttentionViewSwitch value="mine" counts={{ mine: 4, unassigned: 3, company: 2 }} onChange={onChange} />));
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["For you4", "Unassigned3", "Company2"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-attention-view-count="mine"]')?.getAttribute("data-slot")).toBe("badge");
    const unassigned = container.querySelector<HTMLElement>('[data-attention-view="unassigned"]')!;
    await act(async () => {
      unassigned.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      unassigned.focus();
    });
    expect(onChange).toHaveBeenCalledWith("unassigned");
  });

  it("hides an empty For you badge", async () => {
    await act(async () => root.render(<AttentionViewSwitch value="mine" counts={{ mine: 0, unassigned: 1, company: 0 }} onChange={() => {}} />));
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

  it("stays silent until the viewer is known", async () => {
    await act(async () => root.render(<AttentionAudienceLine item={card({ kind: "user", userId: "scott", reason: "addressee" })} currentUserId={null} />));
    expect(container.innerHTML).toBe("");
  });
});
