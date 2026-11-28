import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import {
  attentionAlreadyClosedText,
  attentionCanTransfer,
  attentionCanWithdraw,
  attentionHiddenState,
  attentionHiddenText,
  attentionOtherAudienceUserId,
  attentionTransferTargets,
  planStaleWithdraw,
  readAttentionAlreadyClosed,
  splitArchivedAttentionItems,
  splitStaleAttentionItems,
} from "./attention-close";

const labels = new Map([["scott", "Scott"], ["dotta", "Dotta"], ["riley", "Riley"]]);

function item(id: string, overrides: Partial<AttentionItem> = {}) {
  return {
    id,
    sourceKind: "issue_thread_interaction",
    subject: { id: `${id}-subject` },
    audience: { kind: "user", userId: "scott", reason: "addressee" },
    stale: null,
    closeModes: ["withdraw", "archive", "snooze"], obligationKey: null, obligationLeadId: null,
    ...overrides,
  } as unknown as AttentionItem;
}

describe("attention close helpers (PAP-749 task 2c)", () => {
  it("offers withdraw only where the server lists it, and transfer only for interactions", () => {
    expect(attentionCanWithdraw(item("a"))).toBe(true);
    expect(attentionCanWithdraw(item("b", { sourceKind: "failed_run", closeModes: ["archive", "snooze"] }))).toBe(false);
    expect(attentionCanTransfer(item("a"))).toBe(true);
    expect(attentionCanTransfer(item("c", { sourceKind: "approval" }))).toBe(false);
  });

  it("names the other person only for a card addressed to someone else", () => {
    expect(attentionOtherAudienceUserId(item("a"), "scott")).toBeNull();
    expect(attentionOtherAudienceUserId(item("a"), "dotta")).toBe("scott");
    expect(attentionOtherAudienceUserId(item("p", { audience: { kind: "pool", userId: null, reason: "none" } }), "scott")).toBeNull();
    expect(attentionOtherAudienceUserId(item("c", { audience: { kind: "company", userId: null, reason: "none" } }), "scott")).toBeNull();
  });

  it("transfers to everyone but the viewer and the current owner", () => {
    const forDotta = item("d", { audience: { kind: "user", userId: "dotta", reason: "addressee" } });
    expect(attentionTransferTargets(forDotta, "scott", labels).map((target) => target.label)).toEqual(["Riley"]);
    expect(attentionTransferTargets(item("x", { sourceKind: "decision" }), "scott", labels)).toEqual([]);
  });

  it("splits stale cards from current ones, keeping order", () => {
    const items = [item("1"), item("2", { stale: { reason: "aged" } }), item("3"), item("4", { stale: { reason: "issue_closed" } })];
    const { current, stale } = splitStaleAttentionItems(items);
    expect(current.map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(stale.map((entry) => entry.id)).toEqual(["2", "4"]);
  });

  it("withdraws in bulk only cards with a real withdraw that are not required gates", () => {
    const { withdrawable, required, kept } = planStaleWithdraw([
      item("q"),
      item("budget", { sourceKind: "budget_alert", closeModes: ["archive", "snooze"] }),
      item("hire", { sourceKind: "approval", closeModes: ["archive", "snooze"], required: true }),
      item("approval", { sourceKind: "approval", required: true }),
      item("governed", { required: true }),
    ]);
    expect(withdrawable.map((entry) => entry.id)).toEqual(["q"]);
    // Rule 10: a stale required card goes to a person; it never leaves in bulk.
    expect(required.map((entry) => entry.id)).toEqual(["approval", "governed"]);
    expect(kept.map((entry) => entry.id)).toEqual(["budget", "hire"]);
  });

  it('reads the 409 and says "Already answered by @x"', () => {
    const error = Object.assign(new Error("Already answered"), {
      status: 409,
      body: { error: "Already answered", details: { code: "attention_already_closed", resolvedByUserId: "dotta", resolvedByAgentId: null } },
    });
    const details = readAttentionAlreadyClosed(error)!;
    expect(attentionAlreadyClosedText(details, labels)).toBe("Already answered by @Dotta");
    expect(readAttentionAlreadyClosed(new Error("boom"))).toBeNull();
    expect(attentionAlreadyClosedText({ ...details, resolvedByUserId: null, resolvedByAgentId: "agent-1" }, labels)).toBe("Already answered by an agent");
  });
});

describe("Archived view helpers (PAP-749 task 2e)", () => {
  const hidden = (id: string, kind: "dismiss" | "snooze", snoozedUntil: string | null = null, isActive = true) =>
    item(id, { dismissal: { kind, dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil, isActive } });

  it("reads how a card is hidden for you, and nothing for a card you did not hide", () => {
    expect(attentionHiddenState(hidden("a", "dismiss"))).toEqual({ kind: "archived", since: "2026-10-29T12:00:00.000Z" });
    expect(attentionHiddenState(hidden("s", "snooze", "2026-10-31T09:00:00.000Z")))
      .toEqual({ kind: "snoozed", since: "2026-10-29T12:00:00.000Z", until: "2026-10-31T09:00:00.000Z" });
    // A card that changed (inactive dismissal) is back in its view, not hidden.
    expect(attentionHiddenState(hidden("back", "dismiss", null, false))).toBeNull();
    expect(attentionHiddenState(item("plain"))).toBeNull();
  });

  it('says "Archived <date>" and "Back <time>"', () => {
    expect(attentionHiddenText({ kind: "archived", since: "2026-10-29T12:00:00.000Z" })).toMatch(/^Archived /);
    expect(attentionHiddenText({ kind: "snoozed", since: "2026-10-29T12:00:00.000Z", until: "2026-10-31T09:00:00.000Z" })).toMatch(/^Back /);
  });

  it("puts archived cards first and the Snoozed group soonest first", () => {
    const later = hidden("later", "snooze", "2026-11-05T09:00:00.000Z");
    const sooner = hidden("sooner", "snooze", "2026-10-31T09:00:00.000Z");
    const archived = hidden("archived", "dismiss");
    const { archived: archivedItems, snoozed } = splitArchivedAttentionItems([later, archived, sooner]);
    expect(archivedItems.map((entry) => entry.id)).toEqual(["archived"]);
    expect(snoozed.map((entry) => entry.id)).toEqual(["sooner", "later"]);
  });
});
