import { describe, expect, it } from "vitest";
import type { SsoProviderConfig } from "@paperclipai/shared";
import { withRoleRestrictedUserInfo } from "../auth/better-auth.js";
import type { GenericOAuthConfig } from "better-auth/plugins";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

type GetUserInfoTokens = Parameters<NonNullable<GenericOAuthConfig["getUserInfo"]>>[0];

const PROVIDER: SsoProviderConfig = {
  providerId: "oidc",
  type: "oidc",
  clientId: "client",
  clientSecret: "secret",
  discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
  requiredRoles: {
    claimPath: "resource_access.paperclip.roles",
    roles: ["human"],
  },
};

const BASE_CONFIG: GenericOAuthConfig = {
  providerId: "oidc",
  clientId: "client",
  clientSecret: "secret",
  discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
};

const HUMAN_CLAIMS = {
  sub: "user-1",
  email: "user@example.com",
  email_verified: true,
  name: "User One",
  resource_access: { paperclip: { roles: ["human"] } },
};

describe("withRoleRestrictedUserInfo", () => {
  it("builds the user from id_token claims when the role matches and no upstream getUserInfo exists", async () => {
    const config = withRoleRestrictedUserInfo({ ...BASE_CONFIG }, PROVIDER);
    expect(config.getUserInfo).toBeDefined();

    const user = await config.getUserInfo!({
      idToken: makeJwt(HUMAN_CLAIMS),
    } as GetUserInfoTokens);

    // Better Auth skips its own id_token fallback whenever a getUserInfo
    // override is present, so the wrapper must produce the user itself —
    // a null here surfaces to the browser as "user_info_is_missing".
    expect(user).not.toBeNull();
    expect(user).toMatchObject({
      id: "user-1",
      email: "user@example.com",
      emailVerified: true,
      name: "User One",
    });
  });

  it("delegates to the upstream getUserInfo when the provider helper defines one", async () => {
    const upstreamUser = { id: "upstream", email: "upstream@example.com", name: "Upstream" };
    const config = withRoleRestrictedUserInfo(
      { ...BASE_CONFIG, getUserInfo: async () => upstreamUser },
      PROVIDER,
    );

    const user = await config.getUserInfo!({
      idToken: makeJwt(HUMAN_CLAIMS),
    } as GetUserInfoTokens);

    expect(user).toBe(upstreamUser);
  });

  it("rejects the login when the required role is missing from both tokens", async () => {
    const config = withRoleRestrictedUserInfo({ ...BASE_CONFIG }, PROVIDER);

    const user = await config.getUserInfo!({
      idToken: makeJwt({ ...HUMAN_CLAIMS, resource_access: { paperclip: { roles: ["viewer"] } } }),
    } as GetUserInfoTokens);

    expect(user).toBeNull();
  });

  it("rejects the login when the response carries no tokens at all", async () => {
    const config = withRoleRestrictedUserInfo({ ...BASE_CONFIG }, PROVIDER);

    const user = await config.getUserInfo!({} as GetUserInfoTokens);

    expect(user).toBeNull();
  });

  it("falls back to the access_token role claim when the id_token lacks it", async () => {
    const config = withRoleRestrictedUserInfo({ ...BASE_CONFIG }, PROVIDER);

    const user = await config.getUserInfo!({
      idToken: makeJwt({ ...HUMAN_CLAIMS, resource_access: {} }),
      accessToken: makeJwt({
        sub: "user-1",
        resource_access: { paperclip: { roles: ["human"] } },
      }),
    } as GetUserInfoTokens);

    expect(user).not.toBeNull();
    expect(user).toMatchObject({ id: "user-1", email: "user@example.com" });
  });

  it("leaves providers without requiredRoles untouched", () => {
    const config: GenericOAuthConfig = { ...BASE_CONFIG };
    const result = withRoleRestrictedUserInfo(config, { ...PROVIDER, requiredRoles: undefined });

    expect(result.getUserInfo).toBeUndefined();
  });
});
