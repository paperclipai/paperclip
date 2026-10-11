import { describe, expect, it } from "vitest";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { chatTrustLaneOfIssue, invokerLaneRow } from "./chat-trust-lane.js";

const guest = {
  sourceTrust: {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "quarantined" as const,
  },
};
const verified = { sourceTrust: null };
const row = (name: string, issue: typeof guest | typeof verified) => ({
  name,
  issue,
});

describe("chat trust lanes", () => {
  it("keeps a promoted low-trust task in the guest lane", () => {
    expect(chatTrustLaneOfIssue(guest)).toBe("guest");
    expect(chatTrustLaneOfIssue(verified)).toBe("verified");
    expect(
      chatTrustLaneOfIssue({
        sourceTrust: { ...guest.sourceTrust, disposition: "promoted" },
      }),
    ).toBe("guest");
  });

  describe("invokerLaneRow", () => {
    it("picks the newest task in the invoker's own lane", () => {
      const rows = [
        row("verified-new", verified),
        row("guest-new", guest),
        row("verified-old", verified),
      ];
      expect(invokerLaneRow(rows, true)?.name).toBe("verified-new");
      expect(invokerLaneRow(rows, false)?.name).toBe("guest-new");
    });

    it("lets a verified invoker fall back to the newest guest task", () => {
      const rows = [row("guest-new", guest), row("guest-old", guest)];
      expect(invokerLaneRow(rows, true)?.name).toBe("guest-new");
    });

    it("never gives a guest invoker a verified task", () => {
      expect(
        invokerLaneRow([row("verified", verified)], false),
      ).toBeNull();
      expect(invokerLaneRow([], false)).toBeNull();
      expect(invokerLaneRow([], true)).toBeNull();
    });
  });
});
