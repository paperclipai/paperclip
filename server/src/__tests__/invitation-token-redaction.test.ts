import { describe, expect, it } from "vitest";
import { redactInvitationTokens } from "../middleware/invitation-token-redaction.js";

describe("redactInvitationTokens", () => {
  it.each([
    ["Open [Join](https://app.example.test/invite/legacy8x) now", "Open [Join](https://app.example.test/invite/[REDACTED]) now"],
    ['{"token":"pcp_invite_abc-DEF_123","note":"ok"}', '{"token":"[REDACTED]","note":"ok"}'],
    ["POST /api/invites/pcp_invite_abc/accept", "POST /api/invites/[REDACTED]/accept"],
    ["GET /api/companies/c1/invites and /invites/i1/revoke", "GET /api/companies/c1/invites and /invites/i1/revoke"],
  ])("redacts invitation tokens inside free text: %s", (input, expected) => {
    expect(redactInvitationTokens(input)).toBe(expected);
  });
});
