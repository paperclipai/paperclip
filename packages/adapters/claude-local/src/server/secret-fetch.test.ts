import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLUEPRINT_WORKER_ENV_OVERRIDE,
  BLUEPRINT_WORKER_SECRET_NAME,
  fetchBlueprintWorkerKey,
  SecretFetchError,
  __resetSecretCacheForTests,
  type SecretManagerLike,
} from "./secret-fetch.js";

function makeStubClient(payload: string | Uint8Array | null): SecretManagerLike & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    accessSecretVersion: async () => {
      calls += 1;
      return [{ payload: { data: payload } }];
    },
  };
}

const VALID_KEY = "sk-ant-test-abcdefghij0123456789";

beforeEach(() => {
  __resetSecretCacheForTests();
});

describe("fetchBlueprintWorkerKey", () => {
  it("returns the env-var override without contacting Secret Manager", async () => {
    const stub = makeStubClient(VALID_KEY);
    const secret = await fetchBlueprintWorkerKey({
      envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: VALID_KEY },
      secretManagerClientFactory: async () => stub,
    });
    expect(secret.value).toBe(VALID_KEY);
    expect(secret.source).toBe("env_var");
    expect(secret.name).toBe(BLUEPRINT_WORKER_SECRET_NAME);
    expect(stub.calls).toBe(0);
  });

  it("rejects an env-var override that does not look like an Anthropic key", async () => {
    await expect(
      fetchBlueprintWorkerKey({
        envOverride: { [BLUEPRINT_WORKER_ENV_OVERRIDE]: "not-a-key" },
        secretManagerClientFactory: async () => makeStubClient(VALID_KEY),
      }),
    ).rejects.toMatchObject({
      name: "SecretFetchError",
      code: "malformed_key",
    });
  });

  it("fetches once and caches subsequent calls within the TTL", async () => {
    const stub = makeStubClient(VALID_KEY);
    const opts = {
      projectId: "proj-test",
      ttlMs: 60_000,
      secretManagerClientFactory: async () => stub,
      envOverride: {} as NodeJS.ProcessEnv,
    };
    const a = await fetchBlueprintWorkerKey(opts);
    const b = await fetchBlueprintWorkerKey(opts);
    expect(a.value).toBe(VALID_KEY);
    expect(b.value).toBe(VALID_KEY);
    expect(a.source).toBe("gcp_secret_manager");
    expect(stub.calls).toBe(1);
  });

  it("refetches after the TTL expires", async () => {
    const stub = makeStubClient(VALID_KEY);
    const opts = {
      projectId: "proj-test",
      ttlMs: 1,
      secretManagerClientFactory: async () => stub,
      envOverride: {} as NodeJS.ProcessEnv,
    };
    await fetchBlueprintWorkerKey(opts);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fetchBlueprintWorkerKey(opts);
    expect(stub.calls).toBe(2);
  });

  it("fails closed with missing_project when no projectId is resolvable", async () => {
    await expect(
      fetchBlueprintWorkerKey({
        envOverride: {} as NodeJS.ProcessEnv,
        secretManagerClientFactory: async () => makeStubClient(VALID_KEY),
      }),
    ).rejects.toMatchObject({
      name: "SecretFetchError",
      code: "missing_project",
    });
  });

  it("wraps Secret Manager API errors with secret_manager_failure", async () => {
    const exploding: SecretManagerLike = {
      accessSecretVersion: async () => {
        throw new Error("PERMISSION_DENIED: no IAM");
      },
    };
    await expect(
      fetchBlueprintWorkerKey({
        projectId: "proj-test",
        secretManagerClientFactory: async () => exploding,
        envOverride: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: "SecretFetchError",
      code: "secret_manager_failure",
    });
  });

  it("rejects an empty Secret Manager payload", async () => {
    const stub = makeStubClient(null);
    await expect(
      fetchBlueprintWorkerKey({
        projectId: "proj-test",
        secretManagerClientFactory: async () => stub,
        envOverride: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: "SecretFetchError",
      code: "empty_payload",
    });
  });

  it("rejects a Secret Manager payload that is not an Anthropic key without leaking the payload", async () => {
    const stub = makeStubClient("<!DOCTYPE html><html>403 Forbidden</html>");
    try {
      await fetchBlueprintWorkerKey({
        projectId: "proj-test",
        secretManagerClientFactory: async () => stub,
        envOverride: {} as NodeJS.ProcessEnv,
      });
      expect.fail("expected SecretFetchError");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretFetchError);
      expect((err as SecretFetchError).code).toBe("malformed_key");
      expect((err as Error).message).not.toContain("DOCTYPE");
      expect((err as Error).message).not.toContain("Forbidden");
      expect((err as Error).message).toMatch(/length=\d+/);
    }
  });

  it("accepts a Uint8Array payload (Secret Manager binary path)", async () => {
    const stub = makeStubClient(Buffer.from(VALID_KEY, "utf8"));
    const secret = await fetchBlueprintWorkerKey({
      projectId: "proj-test",
      secretManagerClientFactory: async () => stub,
      envOverride: {} as NodeJS.ProcessEnv,
    });
    expect(secret.value).toBe(VALID_KEY);
    expect(secret.source).toBe("gcp_secret_manager");
  });

  it("surfaces missing_sdk when the dynamic import path is exercised without the SDK installed", async () => {
    // No factory provided -> falls through to dynamic import of @google-cloud/secret-manager.
    // The SDK is not in this package's deps, so the import must fail with missing_sdk.
    await expect(
      fetchBlueprintWorkerKey({
        projectId: "proj-test",
        envOverride: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: "SecretFetchError",
      code: "missing_sdk",
    });
  });
});
