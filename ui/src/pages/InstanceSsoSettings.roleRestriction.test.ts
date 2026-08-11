import { describe, expect, it } from "vitest";
import { hasIncompleteRoleRestriction, type ProviderFormState } from "./InstanceSsoSettings";

function makeForm(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
  return {
    type: "keycloak",
    providerId: "keycloak",
    clientId: "client",
    clientSecret: "secret",
    issuer: "https://idp.example.com/realms/main",
    discoveryUrl: "",
    tenantId: "",
    domain: "",
    displayName: "",
    rolesEnabled: false,
    claimPath: "",
    roles: "",
    ...overrides,
  };
}

describe("hasIncompleteRoleRestriction", () => {
  it("passes a form with role restriction disabled", () => {
    expect(hasIncompleteRoleRestriction(makeForm())).toBe(false);
  });

  it("passes a fully configured role restriction", () => {
    expect(
      hasIncompleteRoleRestriction(
        makeForm({ rolesEnabled: true, claimPath: "resource_access.paperclip.roles", roles: "human" }),
      ),
    ).toBe(false);
  });

  it("flags an enabled restriction with a blank claim path", () => {
    expect(
      hasIncompleteRoleRestriction(makeForm({ rolesEnabled: true, claimPath: "  ", roles: "human" })),
    ).toBe(true);
  });

  it("flags an enabled restriction with no roles", () => {
    expect(
      hasIncompleteRoleRestriction(
        makeForm({ rolesEnabled: true, claimPath: "resource_access.paperclip.roles", roles: "" }),
      ),
    ).toBe(true);
  });

  it("flags roles that collapse to nothing after trimming", () => {
    expect(
      hasIncompleteRoleRestriction(
        makeForm({ rolesEnabled: true, claimPath: "resource_access.paperclip.roles", roles: " , , " }),
      ),
    ).toBe(true);
  });
});
