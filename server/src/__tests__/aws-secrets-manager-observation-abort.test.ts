import { afterEach, expect, it, vi } from "vitest";
import { createAwsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";

const credentials = vi.hoisted(() => ({ resolve: undefined as undefined | (() => Promise<{ accessKeyId: string; secretAccessKey: string }>) }));
// Control only the SDK credential-chain port. Signing, GetSecretValue, fetch,
// response-body handling and the provider's shared credential cache stay real.
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class {
  config = { credentials: () => {
    if (!credentials.resolve) throw new Error("credential fixture not armed");
    return credentials.resolve();
  } };
} }));
const identity = { accessKeyId: "TEST_ACCESS_KEY", secretAccessKey: "test-secret-key" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function provider(region: string) {
  return createAwsSecretsManagerProvider({ config: {
    region, endpoint: `https://secretsmanager.${region}.amazonaws.com`, deploymentId: "test",
    prefix: "paperclip", kmsKeyId: "test-key", environmentTag: "test",
    providerOwnerTag: "paperclip", deleteRecoveryWindowDays: 30,
  } });
}
function input(signal?: AbortSignal) {
  return { material: { scheme: "aws_secrets_manager_v1", source: "external_reference", secretId: "test-secret", versionId: "version-1" },
    externalRef: "test-secret", providerVersionRef: "version-1", ...(signal ? { signal } : {}) };
}
afterEach(() => { vi.restoreAllMocks(); credentials.resolve = undefined; });

it("does not send GetSecretValue after observation abort while shared credentials finish independently", async () => {
  const entered = deferred<void>();
  const release = deferred<typeof identity>();
  credentials.resolve = () => { entered.resolve(); return release.promise; };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ SecretString: "value" })));
  const controller = new AbortController();
  const reason = new Error("observation deadline");
  const operation = provider("us-west-1").resolveVersion(input(controller.signal));
  // Register the rejection before abort; the shared credential promise itself
  // is deliberately not canceled or replaced by this observation.
  const outcome = operation.then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([entered.promise, operation.then(() => { throw new Error("resolver did not enter credentials"); })]);
    controller.abort(reason);
    release.resolve(identity);
    expect(await outcome).toEqual({ error: reason });
    expect(fetch).not.toHaveBeenCalled();
  } finally { release.resolve(identity); await outcome; }
});

it("aborts actual GetSecretValue fetch and preserves ordinary no-signal resolution", async () => {
  credentials.resolve = async () => identity;
  const entered = deferred<AbortSignal>();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const signal = options?.signal;
    if (!signal) throw new Error("normal bounded fetch signal missing");
    entered.resolve(signal);
    return await new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const reason = new Error("observation deadline");
  const p = provider("us-west-2");
  const operation = p.resolveVersion(input(controller.signal));
  const outcome = operation.then(value => ({ value }), error => ({ error }));
  try {
    const actualSignal = await Promise.race([entered.promise, operation.then(() => { throw new Error("fetch not entered"); })]);
    controller.abort(reason);
    expect(await outcome).toEqual({ error: reason });
    expect(actualSignal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ SecretString: "ordinary-value" })));
    expect(await p.resolveVersion(input())).toBe("ordinary-value");
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { controller.abort(reason); await outcome; }
});
