import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterAuthInstance } from "../auth/better-auth.js";

const betterAuthMock = vi.hoisted(() => vi.fn(() => ({ ok: true })));
const drizzleAdapterMock = vi.hoisted(() => vi.fn(() => ({ adapter: true })));

vi.mock("better-auth", () => ({
  betterAuth: betterAuthMock,
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: drizzleAdapterMock,
}));

describe("createBetterAuthInstance", () => {
  beforeEach(() => {
    betterAuthMock.mockClear();
    drizzleAdapterMock.mockClear();
    delete process.env.PAPERCLIP_PUBLIC_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  it("disables secure cookies when the public URL uses plain HTTP", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "http://127.0.0.1:3100";

    createBetterAuthInstance({} as any, {
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://127.0.0.1:3100",
      deploymentMode: "authenticated",
      allowedHostnames: [],
      authDisableSignUp: false,
    } as any);

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        advanced: {
          useSecureCookies: false,
        },
      }),
    );
  });

  it("keeps Better Auth defaults for HTTPS deployments", () => {
    createBetterAuthInstance({} as any, {
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example.com",
      deploymentMode: "authenticated",
      allowedHostnames: [],
      authDisableSignUp: false,
    } as any);

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        advanced: expect.anything(),
      }),
    );
  });
});
