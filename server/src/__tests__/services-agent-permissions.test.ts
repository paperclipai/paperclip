import { describe, expect, it } from "vitest";
import { defaultPermissionsForRole, normalizeAgentPermissions } from "../services/agent-permissions.js";

describe("services/agent-permissions.ts", () => {
  it("grants canCreateAgents by default for ceo role", () => {
    expect(defaultPermissionsForRole("ceo")).toEqual({ canCreateAgents: true });
    expect(defaultPermissionsForRole("engineer")).toEqual({ canCreateAgents: false });
  });

  it("normalizes malformed permission payload to role defaults", () => {
    expect(normalizeAgentPermissions("bad-permissions", "engineer")).toEqual({ canCreateAgents: false });
  });
});

