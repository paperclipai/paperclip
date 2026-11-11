import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { findSecretLeak, findSecretLeakInDirectory, findSecretLeakInJsonValues, findSecretLeakInPersistedState, findSecretLeakMatch, normalizedSecrets, sanitizeJson, secretScanFailureEvidence } from "./redaction.js";

const tokens = {
  account_id: "identity-canary-private-90123",
  access_token: "access-canary-private-23456",
  refresh_token: "refresh-canary-private-56789",
  id_token: "id-canary-private-89012",
};
const sources = { CODEX_AUTH_JSON: JSON.stringify({ tokens }) };
const secrets = normalizedSecrets(Object.values(sources));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(Object.keys(tokens) as Array<keyof typeof tokens>)("classifies %s without returning its value", key => {
  const match = findSecretLeakMatch(`provider state: ${tokens[key]}`, secrets, { sources });
  expect(match).toEqual({ reason: "exact secret value", matchCategory: `CODEX_AUTH_JSON.tokens.${key}` });
  for (const value of secrets) expect(JSON.stringify(match)).not.toContain(value);
  expect(findSecretLeak(tokens[key], secrets)).toBe("exact secret value");
});

it("attributes plain environment credentials and keeps unknown source names private", () => {
  const value = "environment-canary-private-12345";
  expect(findSecretLeakMatch(value, [value], { sources: { OPENAI_API_KEY: value } })).toEqual({
    reason: "exact secret value", matchCategory: "OPENAI_API_KEY",
  });
  const match = findSecretLeakMatch(value, [value], { sources: { [value]: value } });
  expect(match).toEqual({ reason: "exact secret value", matchCategory: "other credential" });
  expect(JSON.stringify(match)).not.toContain(value);
});

it("never echoes account dictionary keys or unknown JSON field names in categories", () => {
  const identity = "account-dictionary-canary-private-09876";
  const key = `${identity}::work`;
  const raw = JSON.stringify({ accounts: { [key]: { [identity]: "nested-token-canary-private-76543" } } });
  const values = normalizedSecrets([raw]);
  const match = findSecretLeakMatch(key, values, { sources: { GROK_AUTH_JSON: raw } });
  expect(match).toEqual({ reason: "exact secret value", matchCategory: "GROK_AUTH_JSON.accounts.[key]" });
  const nested = findSecretLeakMatch("nested-token-canary-private-76543", values, { sources: { GROK_AUTH_JSON: raw } });
  expect(nested?.matchCategory).toBe("GROK_AUTH_JSON.accounts.[field].[field]");
  for (const value of [identity, ...values]) expect(JSON.stringify([match, nested])).not.toContain(value);
});

it("retains attribution across streamed chunks and continues to reject session rollouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "secret-category-scan-")); directories.push(root);
  const file = path.join(root, "codex-home", "sessions", "rollout.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([Buffer.alloc(65_530, "x"), Buffer.from(tokens.account_id), Buffer.alloc(32, "y")]));
  const leak = await findSecretLeakInDirectory(root, secrets, { includeShapes: false, sources });
  expect(leak).toEqual({ file, reason: "exact secret value", matchCategory: "CODEX_AUTH_JSON.tokens.account_id" });
  for (const value of secrets) expect(JSON.stringify(leak)).not.toContain(value);
  // Existing callers retain their reason/shape contract and still fail closed.
  expect(await findSecretLeakInDirectory(root, secrets, { includeShapes: false })).toEqual({ file, reason: "exact secret value" });
});

it("preserves the original provider failure as sanitized scan provenance", () => {
  const evidence = secretScanFailureEvidence({
    scanError: "Secret leak in persisted state: exact secret value (CODEX_AUTH_JSON.tokens.account_id)",
    finding: { file: "codex-home/sessions/rollout.jsonl", stateArea: "Paperclip home", reason: "exact secret value",
      matchCategory: "CODEX_AUTH_JSON.tokens.account_id" },
    originalResult: { status: "failed", failureClass: "transient_infrastructure", error: `HTTP 429 provider unavailable: ${tokens.access_token}` },
  }, secrets) as Record<string, any>;
  expect(evidence.originalResult).toMatchObject({ status: "failed", failureClass: "transient_infrastructure" });
  expect(evidence.originalResult.error).toContain("HTTP 429 provider unavailable");
  expect(evidence.finding.matchCategory).toBe("CODEX_AUTH_JSON.tokens.account_id");
  expect(findSecretLeak(JSON.stringify(evidence), secrets)).toBeNull();
  for (const value of secrets) expect(JSON.stringify(evidence)).not.toContain(value);
});

it("permits only account identity in private Codex diagnostic databases, never artifact scans or tokens", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "codex-private-log-")); directories.push(temporary);
  const root = path.join(temporary, "paperclip-home");
  const home = path.join(root, "instances/runner-e2e-test/runtime/paperclip-runner/durable-sessions/session/codex-home");
  await mkdir(home, { recursive: true });
  const file = path.join(home, "logs_2.sqlite-wal");
  const options = { sources, includeShapes: false, privateCodexRuntimeIdentityRoot: root };
  await writeFile(file, tokens.account_id);
  expect(await findSecretLeakInDirectory(root, secrets, options)).toBeNull();
  expect(await findSecretLeakInDirectory(root, secrets, { sources, includeShapes: false })).toMatchObject({ file, matchCategory: "CODEX_AUTH_JSON.tokens.account_id" });
  for (const key of ["access_token", "refresh_token", "id_token"] as const) {
    await writeFile(file, `${tokens.account_id}\n${tokens[key]}`);
    expect(await findSecretLeakInDirectory(root, secrets, options)).toMatchObject({ file, matchCategory: `CODEX_AUTH_JSON.tokens.${key}` });
  }
  await writeFile(file, tokens.account_id);
  const reused = { ...sources, OPENAI_API_KEY: tokens.account_id };
  expect(await findSecretLeakInDirectory(root, secrets, { ...options, sources: reused })).toMatchObject({ file });
  for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
    const state = path.join(home, name); await writeFile(state, tokens.account_id);
    expect(await findSecretLeakInDirectory(root, secrets, options)).toBeNull();
    await writeFile(state, `${tokens.account_id}\n${tokens.refresh_token}`);
    expect(await findSecretLeakInDirectory(root, secrets, options)).toMatchObject({ file: state, matchCategory: "CODEX_AUTH_JSON.tokens.refresh_token" });
    await rm(state);
  }
  for (const name of ["config.toml", "rollout.jsonl", "unrelated.sqlite", "logs_2.sqlite.backup"]) {
    const other = path.join(home, name); await writeFile(other, tokens.account_id);
    expect(await findSecretLeakInDirectory(root, secrets, options)).toMatchObject({ file: other });
    await rm(other);
  }
  await chmod(temporary, 0o755);
  await expect(findSecretLeakInDirectory(root, secrets, options)).rejects.toThrow("owner-only");
});

it("allows the exact upstream rollout ownership field while scanning all conversation content", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "codex-private-rollout-")); directories.push(temporary);
  const root = path.join(temporary, "paperclip-home");
  const file = path.join(root, "instances/test/runtime/paperclip-runner/durable-sessions/session/codex-home/sessions/2026/10/26/rollout-test.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const options = { sources, includeShapes: false, privateCodexRuntimeIdentityRoot: root };
  const metadata = { type: "session_meta", payload: { creator_account_id: tokens.account_id, base_instructions: { text: "Ordinary instructions" } } };
  await writeFile(file, JSON.stringify(metadata));
  expect(await findSecretLeakInDirectory(root, secrets, options)).toBeNull();
  expect(await findSecretLeakInDirectory(root, secrets, { sources })).toMatchObject({ file });
  for (const record of [
    { ...metadata, payload: { ...metadata.payload, base_instructions: { text: tokens.account_id } } },
    { ...metadata, payload: { ...metadata.payload, token: tokens.access_token } },
    { type: "response_item", payload: { creator_account_id: tokens.account_id } },
    { type: "session_meta", payload: { unexpected_account_id: tokens.account_id } },
  ]) {
    await writeFile(file, JSON.stringify(record));
    expect(await findSecretLeakInDirectory(root, secrets, options)).toMatchObject({ file });
  }
  await writeFile(file, JSON.stringify(metadata) + '\n' + JSON.stringify({ type: "response_item", payload: { text: tokens.account_id } }));
  expect(await findSecretLeakInDirectory(root, secrets, options)).toMatchObject({ file });
});

describe("product-delivered credential persisted-state scope", () => {
  // The invitation join link the agent hands the person is saved in the reply,
  // so the embedded database may hold it. Nothing else may.
  const joinToken = "pcp_invite_ProductDeliveredFixtureToken-0123456789abcdef";
  const otherSecret = "unregistered-private-canary-0123456789";
  async function home(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), "delivered-scan-")); directories.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    await mkdir(paperclipHome, { recursive: true });
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(paperclipHome, relative)), { recursive: true });
      await writeFile(path.join(paperclipHome, relative), text);
    }
    return paperclipHome;
  }
  const dbFile = "instances/runner-e2e-1/db/base/16384/24601";
  const scan = (root: string, productStateRoot?: string) =>
    findSecretLeakInPersistedState(root, [joinToken, otherSecret], [joinToken], { includeShapes: false, ...(productStateRoot ? { productStateRoot } : {}) });

  it("accepts the registered join token inside the embedded database only", async () => {
    const paperclipHome = await home({ [dbFile]: `reply /invite/${joinToken}`, "instances/runner-e2e-1/db/pg_wal/000000010000000000000001": joinToken });
    expect(await scan(paperclipHome, paperclipHome)).toBeNull();
  });

  it.each([
    ["agent run log", "instances/runner-e2e-1/data/run-logs/company/agent/run.ndjson"],
    ["server log", "instances/runner-e2e-1/logs/server.log"],
    ["other instance data", "instances/runner-e2e-1/data/storage/attachment.txt"],
  ])("still rejects the join token in the %s", async (_label, relative) => {
    const paperclipHome = await home({ [dbFile]: joinToken, [relative]: `link /invite/${joinToken}` });
    expect(await scan(paperclipHome, paperclipHome)).toMatchObject({ file: path.join(paperclipHome, relative), reason: "exact secret value" });
  });

  it("still rejects the join token in the workspace and in published evidence", async () => {
    const workspace = await home({ "notes.md": joinToken });
    expect(await scan(workspace)).toMatchObject({ reason: "exact secret value" });
    // Published evidence never gets the database scope, even for a database-shaped path.
    const published = await home({ [dbFile]: joinToken });
    expect(await scan(published)).toMatchObject({ reason: "exact secret value" });
    const reply = { body: `[Join](http://127.0.0.1:3100/invite/${joinToken})` };
    expect(findSecretLeakInJsonValues(reply, [joinToken])).not.toBeNull();
    const safe = sanitizeJson(reply, [joinToken]);
    expect(JSON.stringify(safe)).not.toContain(joinToken);
    expect(findSecretLeakInJsonValues(safe, [joinToken])).toBeNull();
  });

  it("still rejects a different unregistered secret inside the embedded database", async () => {
    const paperclipHome = await home({ [dbFile]: `${joinToken} ${otherSecret}` });
    expect(await scan(paperclipHome, paperclipHome)).toMatchObject({ file: path.join(paperclipHome, dbFile), reason: "exact secret value" });
  });
});
