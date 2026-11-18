import { describe, expect, it } from "vitest";
import { managedConnectorConsentSubject, managedConnectorSubject } from "./client-settings.js";

const oauth = { connectorSubjectUserId: "latest-user" };
const organizationGrant = { kind: "organization", subjectUserId: null, subjectAgentId: null, providerTenant: { externalId: "consenting-user" } };

describe("managed connector subjects", () => {
  it("keeps refresh on the subject rule it has always used", () => {
    expect(managedConnectorSubject(organizationGrant, oauth)).toBe("latest-user");
    expect(managedConnectorSubject({ kind: "agent", subjectUserId: null, subjectAgentId: "a1" }, oauth)).toBe("agent:a1");
    expect(managedConnectorSubject({ kind: "user", subjectUserId: "u1", subjectAgentId: null }, oauth)).toBe("u1");
  });

  it("revokes under the subject that consented to the grant", () => {
    expect(managedConnectorConsentSubject(organizationGrant, oauth)).toBe("consenting-user");
  });

  it("falls back to the refresh rule for grants saved without a consenting subject", () => {
    expect(managedConnectorConsentSubject({ ...organizationGrant, providerTenant: null }, oauth)).toBe("latest-user");
  });
});
