import assert from "node:assert/strict";
import test from "node:test";

import { withIsolatedProfileCredentials } from "./local-provider-smoke-environment.mjs";

test("a later smoke profile cannot observe another provider credential", async () => {
  const environment = {
    PATH: "/bin",
    OPENAI_API_KEY: "credential-from-an-earlier-profile",
  };
  const providerCredentialNames = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

  await assert.rejects(
    withIsolatedProfileCredentials({
      environment,
      providerCredentialNames,
      profileCredentials: {
        ANTHROPIC_API_KEY: "credential-for-current-profile",
      },
      run: async () => {
        assert.equal(environment.OPENAI_API_KEY, undefined);
        assert.equal(
          environment.ANTHROPIC_API_KEY,
          "credential-for-current-profile",
        );
        assert.equal(environment.PATH, "/bin");
        throw new Error("provider failed");
      },
    }),
    /provider failed/,
  );

  assert.deepEqual(environment, { PATH: "/bin" });
});
