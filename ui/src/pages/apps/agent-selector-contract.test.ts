import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("Apps agent selector contract", () => {
  it("keeps every agent chooser under /apps searchable", () => {
    const appConnect = source("./AppsConnect.tsx");
    const connectionSetupFlow = source("../../features/connections/ConnectionSetupFlow.tsx");
    const permissions = source("./app-detail/PermissionsPanel.tsx");
    const tester = source("./app-detail/TestPanel.tsx");
    const profiles = source("../tools/ProfilesTab.tsx");
    const audit = source("../tools/AuditTab.tsx");

    expect(appConnect).toContain("<ConnectionSetupFlow");
    expect(connectionSetupFlow).toContain("<AgentMultiSelect");
    expect(permissions).toContain("<AgentMultiSelect");
    expect(tester).toContain('placeholder="Search agents…"');

    expect(profiles.match(/<AgentSelect/g)).toHaveLength(2);
    expect(profiles).not.toContain("<Select value={agentId}");
    expect(profiles).not.toContain("<Select value={targetAgentId}");

    expect(audit).toContain("<AgentSelect");
    expect(audit).not.toContain("<Select value={agent}");
  });
});
