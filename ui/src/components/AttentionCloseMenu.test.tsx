// @vitest-environment jsdom
import { act, forwardRef, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionAudience, AttentionItem } from "@paperclipai/shared";
import { AttentionCloseMenu, AttentionForOtherGate, AttentionHiddenChip, AttentionSnoozedGroup, AttentionStaleChip, AttentionStaleGroup } from "./AttentionCloseMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }>(({ children, to, ...props }, ref) => (
    <a ref={ref} href={to} {...props}>{children}</a>
  )),
}));

// PAP-749 task 2c: the Close… menu, "This is for @x. Continue?", the Stale
// chip and the Stale (N) group with "Withdraw all stale".
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
  document.body.innerHTML = "";
});

const SCOTT = "scott";
const labels = new Map([["scott", "Scott"], ["dotta", "Dotta"], ["riley", "Riley"]]);
const forScott: AttentionAudience = { kind: "user", userId: SCOTT, reason: "addressee" };
const forDotta: AttentionAudience = { kind: "user", userId: "dotta", reason: "addressee" };

function card(id: string, overrides: Partial<AttentionItem> = {}) {
  return {
    id,
    sourceKind: "issue_thread_interaction",
    subject: { id: `${id}-subject`, kind: "interaction", title: `Card ${id}`, href: `/PAP/issues/PAP-1#${id}`, metadata: {} },
    relatedIssue: { id: "issue-1", identifier: "PAP-1", title: "Task", kind: "issue" },
    audience: forScott,
    stale: null,
    closeModes: ["withdraw", "archive", "snooze"], obligationKey: null, obligationLeadId: null,
    changeFingerprint: "fp.me",
    whyNow: "",
    ...overrides,
  } as unknown as AttentionItem;
}

async function render(node: React.ReactNode) {
  await act(async () => root.render(<>{node}</>));
}

async function openMenu() {
  const trigger = container.querySelector<HTMLElement>("[data-attention-close-menu]")!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function menuItem(mode: string) {
  return document.body.querySelector<HTMLElement>(`[data-attention-close-mode="${mode}"]`);
}

function buttonWithText(text: string, scope: ParentNode = document.body) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

async function click(element: HTMLElement | undefined | null) {
  await act(async () => { element!.click(); });
}

describe("AttentionCloseMenu", () => {
  it("lists only the verbs in closeModes", async () => {
    await render(<AttentionCloseMenu item={card("a", { closeModes: ["archive", "snooze"] })} currentUserId={SCOTT} userLabelMap={labels}
      onWithdraw={vi.fn()} onArchive={vi.fn()} onSnooze={vi.fn()} onTransfer={vi.fn()} />);
    await openMenu();
    expect(menuItem("withdraw")).toBeNull();
    expect(menuItem("archive")?.textContent).toContain("Archive for me");
    expect(menuItem("snooze")?.textContent).toContain("Snooze for me");
    expect(menuItem("transfer")?.textContent).toContain("Transfer to…");
    expect(document.body.textContent).toContain("Open source");
  });

  it("archives for me in one step", async () => {
    const onArchive = vi.fn();
    const item = card("a");
    await render(<AttentionCloseMenu item={item} currentUserId={SCOTT} userLabelMap={labels} onArchive={onArchive} />);
    await openMenu();
    await click(menuItem("archive"));
    expect(onArchive).toHaveBeenCalledWith(item);
  });

  it("offers Restore instead of Archive on a card you archived (PAP-749 task 2e)", async () => {
    const onRestore = vi.fn();
    const item = card("a", { dismissal: { kind: "dismiss", dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil: null, isActive: true } });
    await render(<AttentionCloseMenu item={item} currentUserId={SCOTT} userLabelMap={labels} onArchive={vi.fn()} onSnooze={vi.fn()} onWithdraw={vi.fn()} onRestore={onRestore} />);
    await openMenu();
    expect(menuItem("archive")).toBeNull();
    expect(menuItem("withdraw")).not.toBeNull();
    expect(menuItem("restore")?.textContent).toContain("Restore");
    expect(menuItem("snooze")?.textContent).toContain("Snooze for me");
    await click(menuItem("restore"));
    expect(onRestore).toHaveBeenCalledWith(item);
  });

  it('offers "Restore now" and "Change snooze time" on a snoozed card', async () => {
    const item = card("s", { dismissal: { kind: "snooze", dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil: "2026-10-31T09:00:00.000Z", isActive: true } });
    await render(<AttentionCloseMenu item={item} currentUserId={SCOTT} userLabelMap={labels} onArchive={vi.fn()} onSnooze={vi.fn()} onRestore={vi.fn()} />);
    await openMenu();
    expect(menuItem("restore")?.textContent).toContain("Restore now");
    expect(menuItem("snooze")?.textContent).toContain("Change snooze time");
  });

  it("keeps Archive when no restore handler is given, even for a hidden card", async () => {
    const item = card("a", { dismissal: { kind: "dismiss", dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil: null, isActive: true } });
    await render(<AttentionCloseMenu item={item} currentUserId={SCOTT} userLabelMap={labels} onArchive={vi.fn()} />);
    await openMenu();
    expect(menuItem("restore")).toBeNull();
    expect(menuItem("archive")).not.toBeNull();
  });

  it("confirms a withdraw and sends the reason", async () => {
    const onWithdraw = vi.fn();
    const item = card("a");
    await render(<AttentionCloseMenu item={item} currentUserId={SCOTT} userLabelMap={labels} onWithdraw={onWithdraw} />);
    await openMenu();
    await click(menuItem("withdraw"));
    const dialog = document.body.querySelector<HTMLElement>("[data-attention-withdraw-dialog]")!;
    expect(dialog.textContent).toContain("Withdraw this request?");
    expect(dialog.textContent).toContain("It is not an approval");
    const textarea = dialog.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Plan changed");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onWithdraw).not.toHaveBeenCalled();
    await click(buttonWithText("Withdraw request", dialog));
    expect(onWithdraw).toHaveBeenCalledWith(item, "Plan changed");
  });

  it('asks "This is for @x. Withdraw anyway?" on a card for a different person', async () => {
    await render(<AttentionCloseMenu item={card("a", { audience: forDotta })} currentUserId={SCOTT} userLabelMap={labels} onWithdraw={vi.fn()} />);
    await openMenu();
    await click(menuItem("withdraw"));
    expect(document.body.querySelector("[data-attention-withdraw-dialog]")?.textContent).toContain("This is for @Dotta. Withdraw anyway?");
  });

  it('asks "This is for @x. Continue?" before transferring a different person\'s card', async () => {
    const onTransfer = vi.fn();
    const item = card("a", { audience: forDotta });
    await render(<AttentionCloseMenu item={item} currentUserId={SCOTT} userLabelMap={labels} onTransfer={onTransfer} />);
    await openMenu();
    const sub = menuItem("transfer")!;
    await act(async () => {
      sub.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      sub.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const riley = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent === "@Riley");
    // Dotta owns the card, and Scott is the viewer, so only Riley is offered.
    expect([...document.body.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)).not.toContain("@Dotta");
    await click(riley);
    expect(onTransfer).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This is for @Dotta. Continue?");
    await click(buttonWithText("Transfer to @Riley"));
    expect(onTransfer).toHaveBeenCalledWith(item, "riley");
  });
});

describe("AttentionForOtherGate", () => {
  it("shows the card at once and asks only when the person acts (PAP-767)", async () => {
    const onApprove = vi.fn();
    await render(<AttentionForOtherGate item={card("a", { audience: forDotta })} currentUserId={SCOTT} userLabelMap={labels}>
      <h2>Ship the launch plan</h2><button type="button" onClick={onApprove}>Approve</button>
    </AttentionForOtherGate>);
    // The title and the controls are readable before anything is asked.
    expect(container.textContent).toContain("Ship the launch plan");
    expect(buttonWithText("Approve", container)).toBeTruthy();
    expect(container.textContent).not.toContain("This is for @Dotta");

    await click(buttonWithText("Approve", container));
    expect(onApprove).not.toHaveBeenCalled();
    expect(container.querySelector("[data-attention-for-other-prompt]")?.textContent).toContain("This is for @Dotta. Continue?");

    // Cancel keeps the card as it was; Continue runs the held-back Approve.
    await click(buttonWithText("Cancel", container));
    expect(container.querySelector("[data-attention-for-other-prompt]")).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    await click(buttonWithText("Approve", container));
    await click(buttonWithText("Continue", container));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-attention-for-other-prompt]")).toBeNull();
  });

  it("shows the controls at once on your own card", async () => {
    await render(<AttentionForOtherGate item={card("a")} currentUserId={SCOTT} userLabelMap={labels}><button type="button">Approve</button></AttentionForOtherGate>);
    expect(container.querySelector("[data-attention-for-other-gate]")).toBeNull();
    expect(buttonWithText("Approve", container)).toBeTruthy();
  });
});

describe("AttentionStaleChip", () => {
  it("shows the stale reason", async () => {
    await render(<AttentionStaleChip item={card("a", { stale: { reason: "aged" } })} />);
    expect(container.querySelector('[data-attention-stale="aged"]')?.textContent).toBe("Stale · Waiting 30+ days");
  });

  it("renders nothing for a current card", async () => {
    await render(<AttentionStaleChip item={card("a")} />);
    expect(container.textContent).toBe("");
  });
});

describe("AttentionStaleGroup", () => {
  const stale = [
    card("old", { stale: { reason: "aged" } }),
    card("closed-task", { stale: { reason: "issue_closed" }, audience: forDotta }),
    card("run", { sourceKind: "failed_run", stale: { reason: "aged" }, closeModes: ["archive", "snooze"] }),
    card("approval", { sourceKind: "approval", stale: { reason: "aged" }, required: true }),
  ];

  it("starts collapsed with its count and opens with one click", async () => {
    const onToggle = vi.fn();
    await render(<AttentionStaleGroup items={stale} open={false} onToggle={onToggle} onWithdrawAll={vi.fn()} currentUserId={SCOTT} userLabelMap={labels}><p>cards</p></AttentionStaleGroup>);
    expect(container.textContent).toContain("Stale (4)");
    expect(container.textContent).not.toContain("cards");
    const header = container.querySelector<HTMLElement>("[aria-expanded]")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("lists every card before Withdraw all stale and withdraws only those with a request", async () => {
    const onWithdrawAll = vi.fn();
    await render(<AttentionStaleGroup items={stale} open={false} onToggle={vi.fn()} onWithdrawAll={onWithdrawAll} currentUserId={SCOTT} userLabelMap={labels}><p>cards</p></AttentionStaleGroup>);
    await click(buttonWithText("Withdraw all stale", container));
    expect(onWithdrawAll).not.toHaveBeenCalled();
    const dialog = document.body.querySelector<HTMLElement>("[data-attention-stale-withdraw-dialog]")!;
    expect(dialog.textContent).toContain("Withdraw 2 stale requests?");
    expect(dialog.textContent).toContain("None of them counts as approved");
    const withdrawn = [...dialog.querySelectorAll('[data-attention-stale-list="Will be withdrawn"] [data-attention-stale-item]')].map((row) => row.getAttribute("data-attention-stale-item"));
    expect(withdrawn).toEqual(["old", "closed-task"]);
    expect(dialog.querySelector('[data-attention-stale-item="closed-task"]')?.textContent).toContain("For @Dotta");
    expect(dialog.querySelector('[data-attention-stale-item="run"]')?.closest("[data-attention-stale-list]")?.getAttribute("data-attention-stale-list"))
      .toBe("Stay open: no request to withdraw");
    // A stale required approval goes to a person; bulk withdraw leaves it open.
    expect(dialog.querySelector('[data-attention-stale-item="approval"]')?.closest("[data-attention-stale-list]")?.getAttribute("data-attention-stale-list"))
      .toBe("Stay open: required, withdraw one at a time");
    expect(dialog.querySelector("[data-attention-stale-for-others]")?.textContent).toBe("This is for @Dotta. Continue?");
    await click(buttonWithText("Withdraw 2 requests", dialog));
    expect(onWithdrawAll).toHaveBeenCalledWith([stale[0], stale[1]], "");
  });

  it("names each card in the confirmation with the title the layout's card leads with (PAP-767)", async () => {
    // The classic row leads with the card title.
    await render(<AttentionStaleGroup items={stale} open={false} onToggle={vi.fn()} onWithdrawAll={vi.fn()} currentUserId={SCOTT} userLabelMap={labels}><p>cards</p></AttentionStaleGroup>);
    await click(buttonWithText("Withdraw all stale", container));
    let dialog = document.body.querySelector<HTMLElement>("[data-attention-stale-withdraw-dialog]")!;
    expect(dialog.querySelector('[data-attention-stale-item="old"]')?.textContent).toContain("Card old");
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Needs You passes its own card title.
    await render(<AttentionStaleGroup items={stale} open={false} onToggle={vi.fn()} onWithdrawAll={vi.fn()} currentUserId={SCOTT} userLabelMap={labels}
      titleOf={(item) => `Task for ${item.id}`}><p>cards</p></AttentionStaleGroup>);
    await click(buttonWithText("Withdraw all stale", container));
    dialog = document.body.querySelector<HTMLElement>("[data-attention-stale-withdraw-dialog]")!;
    expect(dialog.querySelector('[data-attention-stale-item="old"]')?.textContent).toContain("Task for old");
    expect(dialog.textContent).not.toContain("Card old");
  });

  it("offers no bulk withdraw when nothing can be withdrawn", async () => {
    await render(<AttentionStaleGroup items={[stale[2]!]} open={false} onToggle={vi.fn()} onWithdrawAll={vi.fn()} currentUserId={SCOTT} userLabelMap={labels}><p>cards</p></AttentionStaleGroup>);
    expect(container.textContent).toContain("Stale (1)");
    expect(buttonWithText("Withdraw all stale", container)).toBeUndefined();
  });

  it("renders nothing without stale cards", async () => {
    await render(<AttentionStaleGroup items={[]} open onToggle={vi.fn()} currentUserId={SCOTT}><p>cards</p></AttentionStaleGroup>);
    expect(container.querySelector("[data-attention-stale-group]")).toBeNull();
  });
});

describe("AttentionHiddenChip and AttentionSnoozedGroup (PAP-749 task 2e)", () => {
  it("shows when a card was archived and when a snoozed card comes back", async () => {
    await render(<>
      <AttentionHiddenChip item={card("a", { dismissal: { kind: "dismiss", dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil: null, isActive: true } })} />
      <AttentionHiddenChip item={card("s", { dismissal: { kind: "snooze", dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil: "2026-10-31T09:00:00.000Z", isActive: true } })} />
      <AttentionHiddenChip item={card("plain")} />
    </>);
    expect(container.querySelector('[data-attention-hidden="archived"]')?.textContent).toMatch(/^Archived /);
    expect(container.querySelector('[data-attention-hidden="snoozed"] time')?.getAttribute("dateTime")).toBe("2026-10-31T09:00:00.000Z");
    expect(container.querySelectorAll("[data-attention-hidden]")).toHaveLength(2);
  });

  it("starts open with its count, collapses with one click, and renders nothing when empty", async () => {
    const onToggle = vi.fn();
    await render(<AttentionSnoozedGroup count={2} open onToggle={onToggle}><p data-child>cards</p></AttentionSnoozedGroup>);
    const group = container.querySelector<HTMLElement>("[data-attention-snoozed-group]")!;
    expect(group.textContent).toContain("Snoozed (2)");
    expect(group.querySelector("[data-child]")).not.toBeNull();
    await click(group.querySelector<HTMLElement>("[aria-expanded]"));
    expect(onToggle).toHaveBeenCalled();
    await render(<AttentionSnoozedGroup count={0} open onToggle={onToggle}><p data-child>cards</p></AttentionSnoozedGroup>);
    expect(container.querySelector("[data-attention-snoozed-group]")).toBeNull();
  });
});
