import { describe, expect, it } from "vitest";
import {
  connectionNameForCredentialPolicy,
  connectionNameForGrantKind,
  connectionTypeLabel,
  isConnectionAvailableToAgents,
} from "./connection-identity";

describe("connectionTypeLabel", () => {
  it("names each credential policy", () => {
    expect(connectionTypeLabel("per_user")).toBe("Personal");
    expect(connectionTypeLabel("per_agent")).toBe("Dedicated agent");
    expect(connectionTypeLabel("shared")).toBe("Organization");
  });
});

describe("connectionNameForGrantKind", () => {
  it("suffixes an organization-owned connection", () => {
    expect(connectionNameForGrantKind("Slack", "organization")).toBe("Slack for the organization");
  });

  it("leaves a user-owned connection alone", () => {
    expect(connectionNameForGrantKind("Slack", "user")).toBe("Slack");
  });

  it("does not suffix a name that already carries the suffix", () => {
    expect(connectionNameForGrantKind("Slack for the organization", "organization"))
      .toBe("Slack for the organization");
  });

  // Connections created before the rename persisted " for the company". The
  // setup flow writes this name back when a draft resumes, so a doubled suffix
  // would be stored, not just rendered.
  it("replaces the legacy suffix instead of appending a second one", () => {
    expect(connectionNameForGrantKind("Slack for the company", "organization"))
      .toBe("Slack for the organization");
  });

  it("matches the legacy suffix regardless of case", () => {
    expect(connectionNameForGrantKind("Slack For The Company", "organization"))
      .toBe("Slack for the organization");
  });

  it("keeps a name that merely mentions the old word", () => {
    expect(connectionNameForGrantKind("Company directory", "organization"))
      .toBe("Company directory for the organization");
  });

  it("trims surrounding whitespace before it decides", () => {
    expect(connectionNameForGrantKind("  Slack for the company  ", "organization"))
      .toBe("Slack for the organization");
  });
});

describe("connectionNameForCredentialPolicy", () => {
  it("suffixes a shared credential and leaves a personal one alone", () => {
    expect(connectionNameForCredentialPolicy("Notion", "shared")).toBe("Notion for the organization");
    expect(connectionNameForCredentialPolicy("Notion", "per_user")).toBe("Notion");
  });

  it("carries the legacy-suffix handling through to the connections list", () => {
    expect(connectionNameForCredentialPolicy("Notion for the company", "shared"))
      .toBe("Notion for the organization");
  });
});

describe("isConnectionAvailableToAgents", () => {
  const base = { status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared", transport: "mcp_remote", lastError: null } as const;
  it("does not count a connection that must be signed in again", () => {
    expect(isConnectionAvailableToAgents(base)).toBe(true);
    expect(isConnectionAvailableToAgents({ ...base, healthStatus: "error" })).toBe(false);
    expect(isConnectionAvailableToAgents({ ...base, credentialPolicy: "per_user", healthStatus: "error", lastError: "oauth_reauthorization_required" })).toBe(false);
    expect(isConnectionAvailableToAgents({ ...base, enabled: false })).toBe(false);
    expect(isConnectionAvailableToAgents({ ...base, status: "draft" })).toBe(false);
  });

  it("keeps counting a personal connection whose health check is stale", () => {
    expect(isConnectionAvailableToAgents({ ...base, credentialPolicy: "per_user", healthStatus: "error" })).toBe(true);
  });
});
