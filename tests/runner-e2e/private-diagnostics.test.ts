import { sanitizePrivateReporterArtifacts } from "./private-reporter-artifacts.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, chmodSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPrivateDiagnosticStream, diagnosticSecrets, PRIVATE_DIAGNOSTICS_ENV, readPrivateDiagnosticSecrets, stagePrivateDiagnostics, trackedPrivateSecrets } from "./private-diagnostics.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function registry() { const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "diagnostic-control-"))); roots.push(root); mkdirSync(path.join(root, "selected-private-inputs"), { mode: 0o700 }); return { root, file: stagePrivateDiagnostics(root, ["selected-case"], []) }; }
describe("private diagnostic output boundary", () => {
  it("redacts secret and escaped variants across chunks, multiline PEM and UTF-8 without losing ordinary failure detail", () => {
    const password = 'synthetic-credential-<&"-12345678';
    const pem = "-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDLVByaXZhdGUtS2V5LUxpbmUx\nU1lOVEhFVElDLVByaXZhdGUtS2V5LUxpbmUy\n-----END PRIVATE KEY-----"; const short = "Ax4\nBy5\nCz6";
    const outputs: string[] = []; const stream = createPrivateDiagnosticStream(() => [password, pem, short], value => outputs.push(value));
    const input = `HTTP503: π provider unavailable ${password}\n${pem}\n${short}\nJSON ${JSON.stringify(password)}\nHTML ${password.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}\nURI ${encodeURIComponent(password)}\nBASE64 ${Buffer.from(password).toString("base64")}\n`;
    const bytes = Buffer.from(input); for (let i = 0; i < bytes.length; i += 3) stream.write(bytes.subarray(i, i + 3)); stream.end();
    const safe = outputs.join(""); for (const value of diagnosticSecrets([password, pem, short]).values) expect(safe).not.toContain(value);
    expect(safe).toContain("HTTP503: π provider unavailable"); expect(stream.redactedSecret()).toBe(true); expect(stream.failed()).toBe(false);
  });
  it("synchronously registers a generated cookie before first output and rereads at final flush", () => {
    const { root, file } = registry(); const secrets = trackedPrivateSecrets([], "selected-case", { [PRIVATE_DIAGNOSTICS_ENV]: file, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root });
    expect(buildPaperclipServerEnvironment({ [PRIVATE_DIAGNOSTICS_ENV]: file })[PRIVATE_DIAGNOSTICS_ENV]).toBeUndefined();
    expect(buildPaperclipServerEnvironment({}, { [PRIVATE_DIAGNOSTICS_ENV]: file })[PRIVATE_DIAGNOSTICS_ENV]).toBeUndefined();
    const outputs: string[] = []; const stream = createPrivateDiagnosticStream(() => readPrivateDiagnosticSecrets(file, root), value => outputs.push(value));
    const cookie = "generated-session-canary-982726351"; secrets.push(cookie);
    expect(readPrivateDiagnosticSecrets(file, root)).toContain(cookie);
    stream.write(Buffer.from(`session ${cookie.slice(0, 9)}`)); stream.write(Buffer.from(cookie.slice(9))); stream.end();
    expect(outputs.join("")).not.toContain(cookie); expect(outputs.join("")).toContain("[REDACTED]");
    expect(readFileSync(file, "utf8")).toContain(cookie); rmSync(path.dirname(file), { recursive: true }); expect(() => readFileSync(file)).toThrow();
  });
  it("fails closed for case mismatch, unsafe permissions, missing registry, oversized lines and late writes", () => {
    const { root, file } = registry();
    expect(() => trackedPrivateSecrets([], "different-case", { [PRIVATE_DIAGNOSTICS_ENV]: file, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root })).toThrow(/mismatch/);
    chmodSync(file, 0o644); expect(() => readPrivateDiagnosticSecrets(file, root)).toThrow(/permissions/); chmodSync(file, 0o600);
    const outputs: string[] = []; const stream = createPrivateDiagnosticStream(() => { throw new Error("private lookup failed"); }, value => outputs.push(value), 64);
    stream.write(Buffer.from("sensitive\n")); stream.write(Buffer.alloc(100, "x")); stream.end(); stream.write(Buffer.from("late private bytes\n"));
    expect(stream.failed()).toBe(true); expect(outputs.join("")).not.toContain("sensitive"); expect(outputs.join("")).not.toContain("late private bytes"); expect(outputs.join("")).toContain("size bound exceeded");
  });
});

it("replays synthetic auth expansion through stream and reporter twice without inventing structural secrets", async () => {
  const auth = JSON.stringify({ tokens: { access_token: "synthetic-access-private-837362", refresh_token: "synthetic-refresh-private-937363" }, last_refresh: "2026-10-26T00:00:00Z" }, null, 2);
  const short = "Ax4\nBy5\nCz6", raw = [auth, short], once = diagnosticSecrets(raw);
  expect(diagnosticSecrets(once)).toEqual(once);
  expect(diagnosticSecrets(diagnosticSecrets(once))).toEqual(once);
  expect(once.values).not.toContain("{"); expect(once.values).not.toContain("}");
  for (const fragment of short.split("\n")) expect(once.values).toContain(fragment);
  const { root } = registry(); const outputs: string[] = [];
  const stream = createPrivateDiagnosticStream(() => raw, value => outputs.push(value));
  stream.write(Buffer.from(`initdb bootstrap exited1\n${auth}\n${short}\n`)); stream.end();
  writeFileSync(path.join(root, "server.log"), outputs.join(""));
  writeFileSync(path.join(root, "playwright-output.json"), JSON.stringify({ status: "failed" }));
  mkdirSync(path.join(root, "playwright-output"));
  const report = path.join(root, "playwright-output", ".last-run.json");
  writeFileSync(report, JSON.stringify({ status: "failed", failedTests: [], nested: { detail: JSON.parse(auth).tokens.access_token } }, null, 2));
  await sanitizePrivateReporterArtifacts(root, once); await sanitizePrivateReporterArtifacts(root, once);
  const safe = readFileSync(report, "utf8"); expect(JSON.parse(safe)).toMatchObject({ status: "failed", failedTests: [] });
  expect(safe).not.toContain(JSON.parse(auth).tokens.access_token);
  expect(readFileSync(path.join(root, "server.log"), "utf8")).toContain("initdb bootstrap exited1");
});

it("preserves independently registered overlapping roots and rejects unbound expansion replay", async () => {
  const first = "synthetic-independent-root-A-873628";
  const second = Buffer.from(first).toString("base64");
  const secondEncoded = Buffer.from(second).toString("base64");
  const expanded = diagnosticSecrets([first, second, "Ax4\nBy5"]);
  expect(expanded.values).toContain(secondEncoded);
  expect(diagnosticSecrets(expanded)).toBe(expanded);
  expect(expanded.values).toContain("Ax4"); expect(expanded.values).toContain("By5");
  expect(() => diagnosticSecrets({ kind: "expanded-private-diagnostic-secrets", values: expanded.values })).toThrow("provenance");
  const outputs: string[] = []; const stream = createPrivateDiagnosticStream(() => [first, second], value => outputs.push(value));
  stream.write(Buffer.from(`independent credential ${secondEncoded}\n`)); stream.end();
  expect(outputs.join("")).not.toContain(secondEncoded);
});
