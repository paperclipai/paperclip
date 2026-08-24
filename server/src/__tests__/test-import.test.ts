import { describe, expect, it } from "vitest";
import { createInviteToken } from "../routes/access.js";

describe("import test", () => {
  it("can import from routes/access", () => {
    expect(createInviteToken().startsWith("pcp_invite_")).toBe(true);
  });
});
