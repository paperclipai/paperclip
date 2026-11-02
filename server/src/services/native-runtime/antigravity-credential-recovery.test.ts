import { access, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const homes = vi.hoisted(() => [] as string[]);
const removal = vi.hoisted(() => ({ failures: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (removal.failures && String(args[0]).split("/").at(-1)?.startsWith("paperclip-google-recovery-")) {
      removal.failures -= 1;
      await actual.rm(join(String(args[0]), "antigravity-acp", "acp_token.json"), { force: true });
      throw new Error("fixture partial home removal");
    }
    return actual.rm(...args);
  }, mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
    const home = await actual.mkdtemp(...args);
    homes.push(String(home));
    return home;
  } };
});
import { prepareAntigravityCredentialRecovery } from "./antigravity-runner-credentials.js";
import { reconcileRetainedGoogleCleanup } from "../retained-google-credential-cleanup.js";

const credential = (token: string) => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
});
afterEach(async () => {
  removal.failures = 0;
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("retired Google verification ownership", () => {
  it("retries partial home removal without reusing an already handed-off token", async () => {
    const scope = { companyId: randomUUID(), accountKey: randomUUID() };
    const persistVerified = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access", refresh_token: "fixture-latest" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email: "alice@example.test" }));
    vi.stubGlobal("fetch", request);
    removal.failures = 1;
    await expect(prepareAntigravityCredentialRecovery({ originalCredential: credential("fixture-original"),
      refreshedCredential: credential("fixture-retired"), accountEmail: "alice@example.test", scope, persistVerified,
    })).rejects.toThrow("fixture partial home removal");
    await reconcileRetainedGoogleCleanup(scope);
    expect(persistVerified).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    await expect(access(homes.at(-1)!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the newest rotated token until verified encrypted replacement succeeds", async () => {
    const scope = { companyId: randomUUID(), accountKey: randomUUID() };
    const persistVerified = vi.fn().mockRejectedValueOnce(new Error("fixture encrypted replacement unavailable")).mockResolvedValue(undefined);
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "fixture-access", refresh_token: "fixture-latest" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email: "alice@example.test" }))
      .mockResolvedValueOnce(Response.json({ access_token: "fixture-access", refresh_token: "fixture-retried" }))
      .mockResolvedValueOnce(Response.json({ email_verified: true, email: "alice@example.test" }));
    vi.stubGlobal("fetch", request);
    await expect(prepareAntigravityCredentialRecovery({ originalCredential: credential("fixture-original"),
      refreshedCredential: credential("fixture-retired"), accountEmail: "alice@example.test", scope, persistVerified,
    })).rejects.toThrow("fixture encrypted replacement unavailable");
    const home = homes.at(-1)!;
    expect(await readFile(join(home, "antigravity-acp", "acp_token.json"), "utf8")).toBe(credential("fixture-latest"));
    expect(persistVerified).toHaveBeenNthCalledWith(1, credential("fixture-latest"));
    await reconcileRetainedGoogleCleanup(scope);
    expect(new URLSearchParams(request.mock.calls[2][1].body).get("refresh_token")).toBe("fixture-latest");
    expect(persistVerified).toHaveBeenNthCalledWith(2, credential("fixture-retried"));
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
