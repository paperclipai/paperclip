import { describe, expect, it, vi } from "vitest";
import { inviteEmailHook, noopInviteEmailTransport } from "./invite-email.js";

describe("inviteEmailHook", () => {
  const payload = {
    email: "teammate@example.com",
    inviteUrl: "https://example.com/i/abc",
    companyName: "Acme",
    role: "operator" as const,
  };

  it("does not send when no recipient email is present", async () => {
    const transport = { sendInviteEmail: vi.fn(async () => {}) };
    await inviteEmailHook(transport, { ...payload, email: null });
    expect(transport.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("sends when a transport and recipient are present", async () => {
    const transport = { sendInviteEmail: vi.fn(async () => {}) };
    await inviteEmailHook(transport, payload);
    expect(transport.sendInviteEmail).toHaveBeenCalledWith(payload);
  });

  it("the noop transport never throws and never sends", async () => {
    await expect(
      noopInviteEmailTransport.sendInviteEmail(payload),
    ).resolves.toBeUndefined();
  });

  it("swallows transport errors so invite creation never fails", async () => {
    const transport = {
      sendInviteEmail: vi.fn(async () => {
        throw new Error("smtp down");
      }),
    };
    await expect(inviteEmailHook(transport, payload)).resolves.toBeUndefined();
  });
});
