import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  chatLabel,
  codesMatch,
  generateVerificationCode,
  getMessageContext,
  isAuthorizedApprover,
  isHandshakeExpired,
  newHandshakeExpiry,
  saveMessageContext,
} from "./pairing.js";
import type { ApprovalConfig, MessageContext, PairedChat } from "./types.js";

/** Minimal in-memory PluginContext stub for the instance-scoped state store. */
function makeCtx(): PluginContext {
  const store = new Map<string, unknown>();
  const key = (scope: unknown) => JSON.stringify(scope);
  return {
    state: {
      get: async (scope: unknown) => store.get(key(scope)),
      set: async (scope: unknown, value: unknown) => {
        store.set(key(scope), value);
      },
    },
  } as unknown as PluginContext;
}

const sampleContext = (issueId: string): MessageContext => ({
  kind: "comment_thread",
  companyId: "company-1",
  issueId,
  identifier: "PAP-1",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const pairedChat = (over: Partial<PairedChat> = {}): PairedChat => ({
  chatId: "100",
  chatLabel: "Team",
  pairedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const approval = (over: Partial<ApprovalConfig> = {}): ApprovalConfig => ({
  enabled: true,
  approverAgentId: null,
  agents: {},
  ...over,
});

describe("generateVerificationCode", () => {
  it("returns a 6-character uppercase code", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  it("excludes ambiguous characters (0, O, 1, I, L)", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateVerificationCode();
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });
});

describe("codesMatch", () => {
  it("matches case-insensitively", () => {
    expect(codesMatch("ABC123", "abc123")).toBe(true);
    expect(codesMatch("aBc123", "AbC123")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(codesMatch("  ABC123  ", "ABC123")).toBe(true);
  });

  it("rejects mismatches", () => {
    expect(codesMatch("ABC123", "ABC124")).toBe(false);
    expect(codesMatch("ABC", "ABC123")).toBe(false); // length mismatch
  });
});

describe("isHandshakeExpired", () => {
  it("treats past expiry as expired", () => {
    expect(
      isHandshakeExpired(
        { stage: "awaiting_chat", targetCompanyId: "co-1", expiresAt: new Date(0).toISOString() },
        Date.now(),
      ),
    ).toBe(true);
  });

  it("treats future expiry as not expired", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      isHandshakeExpired({ stage: "awaiting_chat", targetCompanyId: "co-1", expiresAt: future }, Date.now()),
    ).toBe(false);
  });

  it("treats malformed expiry as expired", () => {
    expect(
      isHandshakeExpired({
        stage: "awaiting_chat",
        targetCompanyId: "co-1",
        expiresAt: "not-a-date",
      }),
    ).toBe(true);
  });
});

describe("newHandshakeExpiry", () => {
  it("returns an ISO string ~10 minutes in the future", () => {
    const now = Date.now();
    const expiry = Date.parse(newHandshakeExpiry(now));
    expect(expiry - now).toBeGreaterThanOrEqual(9 * 60_000);
    expect(expiry - now).toBeLessThanOrEqual(11 * 60_000);
  });
});

describe("chatLabel", () => {
  it("prefers @username when present", () => {
    expect(
      chatLabel({ id: 1, type: "private", username: "alice", first_name: "A" }),
    ).toBe("@alice");
  });

  it("falls back to chat title for groups/channels", () => {
    expect(chatLabel({ id: -1, type: "group", title: "Team Chat" })).toBe(
      "Team Chat",
    );
  });

  it("composes first/last name when no username or title", () => {
    expect(
      chatLabel({
        id: 1,
        type: "private",
        first_name: "Alice",
        last_name: "Smith",
      }),
    ).toBe("Alice Smith");
  });

  it("returns chat:<id> when nothing else is known", () => {
    expect(chatLabel({ id: 42, type: "private" })).toBe("chat:42");
  });
});

describe("message context store (chat-scoped keys)", () => {
  it("isolates contexts across chats that share a message id", async () => {
    const ctx = makeCtx();
    // Same numeric message id (5) in two different chats.
    await saveMessageContext(ctx, "100", 5, sampleContext("issue-a"));
    await saveMessageContext(ctx, "200", 5, sampleContext("issue-b"));

    const a = await getMessageContext(ctx, "100", 5);
    const b = await getMessageContext(ctx, "200", 5);
    expect(a && a.kind === "comment_thread" && a.issueId).toBe("issue-a");
    expect(b && b.kind === "comment_thread" && b.issueId).toBe("issue-b");
  });

  it("does not resolve a context for the wrong chat", async () => {
    const ctx = makeCtx();
    await saveMessageContext(ctx, "100", 5, sampleContext("issue-a"));
    expect(await getMessageContext(ctx, "999", 5)).toBeUndefined();
  });
});

describe("isAuthorizedApprover", () => {
  it("allows only the explicitly configured approver when set", () => {
    const cfg = approval({ approverTelegramUserId: 42 });
    expect(isAuthorizedApprover(cfg, pairedChat({ pairedByTelegramUserId: 7 }), 42)).toBe(true);
    // Explicit config wins even over the pairing operator.
    expect(isAuthorizedApprover(cfg, pairedChat({ pairedByTelegramUserId: 7 }), 7)).toBe(false);
    expect(isAuthorizedApprover(cfg, pairedChat(), undefined)).toBe(false);
  });

  it("falls back to the pairing operator when no explicit approver is set", () => {
    const chat = pairedChat({ pairedByTelegramUserId: 7 });
    expect(isAuthorizedApprover(approval(), chat, 7)).toBe(true);
    expect(isAuthorizedApprover(approval(), chat, 8)).toBe(false);
    expect(isAuthorizedApprover(undefined, chat, 7)).toBe(true);
  });

  it("allows anyone for legacy chats with neither id recorded (no lock-out on upgrade)", () => {
    expect(isAuthorizedApprover(undefined, pairedChat(), 123)).toBe(true);
    expect(isAuthorizedApprover(approval(), pairedChat(), 123)).toBe(true);
    expect(isAuthorizedApprover(undefined, undefined, 123)).toBe(true);
  });
});
