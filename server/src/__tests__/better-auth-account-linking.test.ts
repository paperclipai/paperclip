import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_PUBLIC_URL",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("Better Auth account linking", () => {
  afterEach(restoreEnv);

  it("disables implicit linking in the resolved Better Auth context", async () => {
    process.env.BETTER_AUTH_SECRET = "test-only-secret-012345678901234567890123456789";
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_PUBLIC_URL;

    const config = {
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://localhost:3100",
      deploymentMode: "authenticated",
      allowedHostnames: [],
      authDisableSignUp: false,
    } as Config;
    const auth = createBetterAuthInstance({} as Db, config, []);
    const context = await (auth as unknown as {
      $context: Promise<{
        options: {
          account?: { accountLinking?: { disableImplicitLinking?: boolean } };
        };
      }>;
    }).$context;

    expect(context.options.account?.accountLinking?.disableImplicitLinking).toBe(true);
  });
});
