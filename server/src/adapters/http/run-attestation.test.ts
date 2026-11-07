import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const guardedFetchMock = vi.hoisted(() => vi.fn());
vi.mock("./remote-fetch.js", () => ({ guardedHttpAdapterFetch: guardedFetchMock }));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const issueId = "44444444-4444-4444-8444-444444444444";
const url = "https://receiver.example.test/security/heartbeat";
const keyEnv = "PAPERCLIP_HTTP_RUN_ATTESTATION_KEY_FILE";
const root = mkdtempSync(join(tmpdir(), "paperclip-http-attestation-"));
const keyPath = join(root, "key.pem");
const pair = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
writeFileSync(keyPath, pair.privateKey, { mode: 0o600 });

function context(config: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId,
    issueId,
    agent: { id: agentId, companyId, name: "Security", adapterType: "http", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { url, runAttestation: true, ...config },
    context: { issueId, role: "security", approval: true, PAPERCLIP_API_KEY: "pcp-secret" },
    onLog: async () => {},
  };
}

beforeEach(() => {
  process.env[keyEnv] = keyPath;
  guardedFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  guardedFetchMock.mockReset();
  delete process.env[keyEnv];
  chmodSync(keyPath, 0o600);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function sentRequest() {
  const [target, options] = guardedFetchMock.mock.calls[0] as [string, RequestInit];
  const token = new Headers(options.headers).get("x-paperclip-run-attestation");
  expect(token).toBeTruthy();
  const [headerPart, payloadPart, signaturePart] = token!.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString()) as Record<string, unknown>;
  const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as Record<string, unknown>;
  return { target, options, header, claims, headerPart, payloadPart, signaturePart };
}

describe("HTTP run attestation", () => {
  it("checks the authenticated configuration without making an anonymous HEAD probe", async () => {
    const result = await testEnvironment({ companyId, adapterType: "http", config: { url, runAttestation: true } });
    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toContain("http_run_attestation_probe_skipped");
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails the authenticated environment check when the signing key is unavailable", async () => {
    delete process.env[keyEnv];
    const result = await testEnvironment({ companyId, adapterType: "http", config: { url, runAttestation: true } });
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("http_run_attestation_key_invalid");
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("signs only the exact receiver and verified run claims without forwarding credentials or roles", async () => {
    const onDispatch = vi.fn();
    await execute({ ...context(), onDispatch });
    const { target, options, header, claims, headerPart, payloadPart, signaturePart } = sentRequest();
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(target).toBe(url);
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    expect(Object.keys(Object.fromEntries(new Headers(options.headers)))).toEqual([
      "content-type", "x-paperclip-run-attestation",
    ]);
    expect(header).toMatchObject({ alg: "EdDSA", typ: "paperclip-http-run+jwt" });
    expect(claims).toMatchObject({
      iss: "paperclip-http-run", aud: url, sub: agentId, company_id: companyId,
      adapter_type: "http", run_id: runId, issue_id: issueId,
    });
    expect(Object.keys(claims).sort()).toEqual([
      "adapter_type", "aud", "company_id", "exp", "iat", "iss", "issue_id",
      "jti", "nbf", "run_id", "sub",
    ]);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(120);
    expect(verify(null, Buffer.from(`${headerPart}.${payloadPart}`), pair.publicKey, Buffer.from(signaturePart, "base64url"))).toBe(true);
    expect(JSON.parse(String(options.body))).toEqual({ agentId, companyId, runId, issueId });
    expect(Buffer.byteLength(String(options.body), "utf8")).toBeLessThanOrEqual(2048);
    expect(String(options.body)).not.toContain("pcp-secret");
  });

  it("ignores a caller-supplied issue and rejects missing or mismatched server IDs", async () => {
    await execute({ ...context(), context: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    expect(sentRequest().claims.issue_id).toBe(issueId);
    guardedFetchMock.mockClear();
    await expect(execute({ ...context(), issueId: null })).rejects.toThrow("issue UUIDs");
    await expect(execute({ ...context(), runId: "wrong-run" })).rejects.toThrow("UUIDs");
    await expect(execute({ ...context(), agent: { ...context().agent, id: "wrong-agent" } })).rejects.toThrow("UUIDs");
    await expect(execute({ ...context(), agent: { ...context().agent, companyId: "wrong-company" } })).rejects.toThrow("UUIDs");
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for unsafe endpoints, methods, headers, and templates", async () => {
    await expect(execute(context({ url: "http://receiver.example.test/security/heartbeat" }))).rejects.toThrow("HTTPS endpoint");
    await expect(execute(context({ url: "https://user:pass@receiver.example.test/security/heartbeat" }))).rejects.toThrow("HTTPS endpoint");
    await expect(execute(context({ url: `${url}#fragment` }))).rejects.toThrow("HTTPS endpoint");
    await expect(execute(context({ method: "GET" }))).rejects.toThrow("requires POST");
    await expect(execute(context({ headers: { "X-Paperclip-Run-Attestation": "forged" } }))).rejects.toThrow("reserved");
    await expect(execute(context({ headers: { Authorization: "Bearer pcp-secret" } }))).rejects.toThrow("forbids configured headers");
    await expect(execute(context({ payloadTemplate: { token: "pcp-secret" } }))).rejects.toThrow("forbids a payload template");
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("requires a private Ed25519 key file and refuses symlinks", async () => {
    delete process.env[keyEnv];
    await expect(execute(context())).rejects.toThrow(keyEnv);
    process.env[keyEnv] = keyPath;
    chmodSync(keyPath, 0o644);
    await expect(execute(context())).rejects.toThrow("private regular file");
    chmodSync(keyPath, 0o600);
    const linkPath = join(root, "key-link.pem");
    symlinkSync(keyPath, linkPath);
    process.env[keyEnv] = linkPath;
    await expect(execute(context())).rejects.toThrow("private regular file");
    unlinkSync(linkPath);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects a key FIFO without blocking the server process", () => {
    const fifoPath = join(root, "key-pipe.pem");
    const created = spawnSync("mkfifo", [fifoPath]);
    expect(created.status).toBe(0);
    const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const moduleUrl = new URL("./run-attestation.ts", import.meta.url).href;
    const checked = spawnSync(process.execPath, [
      "--import", loader, "--input-type=module", "-e",
      `import { validateHttpRunAttestationKey } from ${JSON.stringify(moduleUrl)}; validateHttpRunAttestationKey();`,
    ], { env: { ...process.env, [keyEnv]: fifoPath }, timeout: 5000, encoding: "utf8" });
    expect(checked.error).toBeUndefined();
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain("private regular file");
  });

  it("uses the same canonical endpoint for the guarded transport and audience", async () => {
    await execute(context({ url: "https://RECEIVER.EXAMPLE.TEST:443/security/heartbeat" }));
    const { target, claims } = sentRequest();
    expect(target).toBe(url);
    expect(claims.aud).toBe(target);
  });

  it("preserves legacy webhook payloads when attestation is disabled", async () => {
    delete process.env[keyEnv];
    await execute(context({ runAttestation: false }));
    const [target, options] = guardedFetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(url);
    expect(new Headers(options.headers).has("x-paperclip-run-attestation")).toBe(false);
    expect(JSON.parse(String(options.body))).toMatchObject({ runId, agentId, context: { PAPERCLIP_API_KEY: "pcp-secret" } });
  });
});
