import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyDirectGitHubAppRuntimeToken,
  mintDirectGitHubAppToken,
} from "./github-app-runtime-credentials.js";

function fixtureKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

describe("direct GitHub App runtime credentials", () => {
  it("mints an installation token without passing App material to the runtime env", async () => {
    const privateKey = fixtureKey();
    let request: Request | undefined;
    const runtime = await mintDirectGitHubAppToken({
      env: {
        GITHUB_APP_ID: "5199792",
        GITHUB_APP_INSTALLATION_ID: "168209392",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      now: () => 1_700_000_000_000,
      fetch: async (_url, init) => {
        request = new Request(String(_url), init);
        return new Response(
          JSON.stringify({ token: "ghs.ephemeral", expires_at: "2026-10-07T01:00:00Z" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(runtime).toEqual({ token: "ghs.ephemeral", expiresAt: "2026-10-07T01:00:00Z" });
    expect(request?.method).toBe("POST");
    expect(request?.url).toContain("/app/installations/168209392/access_tokens");
    expect(request?.headers.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);

    const env = applyDirectGitHubAppRuntimeToken(
      {
        GITHUB_APP_ID: "5199792",
        GITHUB_APP_INSTALLATION_ID: "168209392",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        EXISTING: "preserved",
      },
      runtime!,
    );
    expect(env).toEqual({ EXISTING: "preserved", GH_TOKEN: "ghs.ephemeral", GITHUB_TOKEN: "ghs.ephemeral" });
  });

  it("does not mint when no App binding is present", async () => {
    await expect(mintDirectGitHubAppToken({ env: {}, fetch: async () => { throw new Error("must not fetch"); } })).resolves.toBeNull();
  });

  it("fails closed on a partial App binding", async () => {
    await expect(mintDirectGitHubAppToken({ env: { GITHUB_APP_ID: "5199792" } })).rejects.toThrow("incomplete");
  });
});
