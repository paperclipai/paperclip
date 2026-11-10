import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CHAT_ORACLE_KEY_ENV, privateOracleIdentity, verifyRetainedPrivateOracle } from "./chat-private-oracle.js";
import { stageChatPrivateInputs, chatPrivateInputNameIdentity, verifyRetainedChatOracleIdentity, scrubChatPrivateEnvironment, CHAT_PRIVATE_INPUTS_ENV } from "./chat-private-inputs.js";
import type { MatrixExecution } from "./types.js";
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(path.join(tmpdir(), "chat-oracle-")); roots.push(root); const key = path.join(root, "campaign-key"); writeFileSync(key, randomBytes(32), { mode: 0o600 }); return { root, key, env: { [CHAT_ORACLE_KEY_ENV]: key } }; }
const fields = ["recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "apiVersion"];
const values = { recentMarker: "private-recent", olderMarker: "private-old", recentFactJson: '{"subject":"Acorn","value":"private-fact","aliases":["private-alias"]}', olderFactJson: '{"subject":"Old","value":"old-fact"}', apiVersion: "2025-09-03" };
it("commits every audited actual semantic expectation while excluding credentials/incidental IDs", () => {
  const f = fixture(); const original = privateOracleIdentity("notion", fields, values, f.env)!;
  for (const field of fields) expect(privateOracleIdentity("notion", fields, { ...values, [field]: `${values[field as keyof typeof values]}-changed` }, f.env)?.commitment).not.toBe(original.commitment);
  expect(privateOracleIdentity("notion", fields, { ...values, workspaceId: "different-disposable-id", tokenEnv: "different-secret-ref" }, f.env)).toEqual(original);
  const publicValue = JSON.stringify(original); for (const value of Object.values(values)) expect(publicValue).not.toContain(value);
  expect(publicValue).not.toContain(createHash("sha256").update(values.recentFactJson).digest("hex"));
  expect(() => verifyRetainedPrivateOracle(original, "notion", fields, values, f.env)).not.toThrow();
});
it("commits the actual AgentMail recipient without retaining its address or a low-entropy digest",()=>{
 const f=fixture(),recipient="synthetic-owner@agentmail.to",identity=privateOracleIdentity("agentmail",["recipient","inboxId","apiTokenEnv"],{recipient,inboxId:recipient,apiTokenEnv:"PAPERCLIP_CHAT_EVAL_AGENTMAIL"},f.env)!;
 expect(identity.fields).toEqual(["recipient"]);expect(privateOracleIdentity("agentmail",["recipient"],{recipient:"different@agentmail.to"},f.env)?.commitment).not.toBe(identity.commitment);
 const publicValue=JSON.stringify(identity);expect(publicValue).not.toContain(recipient);expect(publicValue).not.toContain(createHash("sha256").update(recipient).digest("hex"));
 expect(()=>verifyRetainedPrivateOracle(identity,"agentmail",["recipient"],{recipient:"different@agentmail.to"},f.env)).toThrow("mismatch");
});
it("refuses lost, replaced or absent campaign keys and changed retained expectations without creating a replacement", () => {
  const f = fixture(); const original = privateOracleIdentity("notion", fields, values, f.env)!;
  expect(() => privateOracleIdentity("notion", fields, values, {})).toThrow("key unavailable");
  expect(() => verifyRetainedPrivateOracle(original, "notion", fields, { ...values, recentMarker: "changed" }, f.env)).toThrow("mismatch");
  writeFileSync(f.key, randomBytes(32)); expect(() => verifyRetainedPrivateOracle(original, "notion", fields, values, f.env)).toThrow("mismatch");
  rmSync(f.key); expect(() => verifyRetainedPrivateOracle(original, "notion", fields, values, f.env)).toThrow();
});
it("retains only opaque names/commitments across envelope cleanup and requalifies with actual host expectations/key", () => {
  const f = fixture(); const config = path.join(f.root, "external.json"); const keyBytes = readFileSync(f.key).toString("hex");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, providers: { notion: { disposable: true, resourceIds: ["disposable"], credentialEnv: ["PAPERCLIP_CHAT_EVAL_NOTION_AUTH"], prerequisites: values } } }), { mode: 0o600 });
  const descriptor = { externalInput: { provider: "notion" as const, fields } }; const execution = { id: "selected" } as MatrixExecution;
  const env = { ...f.env, PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG: config, PAPERCLIP_CHAT_EVAL_NOTION_AUTH: "never-committed-credential" };
  const staged = stageChatPrivateInputs({ execution, descriptor, privateDir: f.root, secrets: [], env }); const retained = chatPrivateInputNameIdentity("selected", { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: f.root });
  rmSync(staged.filename); expect(() => verifyRetainedChatOracleIdentity(retained, descriptor, env)).not.toThrow();
  expect(JSON.stringify(retained)).not.toContain(keyBytes); expect(JSON.stringify(retained)).not.toContain("never-committed-credential");
  const publicEnv = scrubChatPrivateEnvironment({ ...env }, []); expect(publicEnv[CHAT_ORACLE_KEY_ENV]).toBeUndefined();
  rmSync(f.key); expect(() => verifyRetainedChatOracleIdentity(retained, descriptor, env)).toThrow();
});
