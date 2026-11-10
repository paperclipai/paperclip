import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { runOwnedInstalledPreparation, admitsInstalledChat, installedChatTreeIdentity, refreshInstalledChatPins, validateChatInstallConfiguration, CHAT_INSTALL_PLAN } from "./chat-installed-lane.js";
import type { MatrixExecution } from "./types.js";
const roots: string[] = []; const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const folder = mkdtempSync(path.join(tmpdir(), "chat-installed-")); roots.push(folder); return folder; }
it("admits only exact published pins and the two selected source-local Codex operator cases", () => {
  const pin = { version: "1.2.3", integrity: "sha512-YWJj" };
  expect(validateChatInstallConfiguration({ schemaVersion: 1, disposable: true, source: pin }).source).toEqual(pin);
  for (const source of [{ ...pin, version: "file:/source-pack" }, { ...pin, integrity: "unverified" }])
    expect(() => validateChatInstallConfiguration({ schemaVersion: 1, disposable: true, source })).toThrow();
  const execution = { suite: { id: "chat-features", manualOnly: true }, task: { id: "instance-operations.update-instance", flow: "agent_chat" }, profile: { id: "runner-codex-subscription" }, environment: { id: "local" } } as MatrixExecution;
  expect(admitsInstalledChat(execution)).toBe(true);
  const remote = { ...execution, profile: { ...execution.profile, id: "runner-opencode", provider: "opencode", model: CHAT_OPENCODE_MODEL, adapterType: "paperclip_runner", credential: "OPENROUTER_API_KEY" as const } };
  expect(admitsInstalledChat(remote)).toBe(true);
  expect(admitsInstalledChat({ ...remote, profile: { ...remote.profile, model: "other" } })).toBe(false);
  expect(admitsInstalledChat({ ...execution, task: { ...execution.task, id: "tasks.create-backlog" } })).toBe(false);
  expect(admitsInstalledChat({ ...execution, environment: { ...execution.environment, id: "daytona" } })).toBe(false);
});
it("hashes the complete actual dependency tree and rejects external dependency links", () => {
  const folder = root(), prefix = path.join(folder, "prefix"); mkdirSync(prefix); writeFileSync(path.join(prefix, "dependency.js"), "original");
  const first = installedChatTreeIdentity(prefix); writeFileSync(path.join(prefix, "dependency.js"), "tampered");
  expect(installedChatTreeIdentity(prefix).treeSha256).not.toBe(first.treeSha256);
  writeFileSync(path.join(folder, "outside.js"), "outside"); symlinkSync(path.join(folder, "outside.js"), path.join(prefix, "escaping.js"));
  expect(() => installedChatTreeIdentity(prefix)).toThrow("escapes");
});
it("compares real source bytes to the retained public-artifact pins before every restart", () => {
  const folder = root(), prefix = path.join(folder, "prefix"), cliRoot = path.join(prefix, "lib/node_modules/paperclipai"), serverRoot = path.join(cliRoot, "node_modules/@paperclipai/server");
  mkdirSync(path.join(cliRoot, "dist"), { recursive: true }); mkdirSync(path.join(serverRoot, "dist"), { recursive: true });
  const cli = path.join(cliRoot, "dist/index.js"), server = path.join(serverRoot, "dist/index.js");
  writeFileSync(cli, "export const cli=true;"); writeFileSync(server, "export const server=true;");
  writeFileSync(path.join(cliRoot, "package.json"), JSON.stringify({ name: "paperclipai", version: "1.2.3" }));
  writeFileSync(path.join(serverRoot, "package.json"), JSON.stringify({ name: "@paperclipai/server", version: "1.2.3" }));
  const planFile = path.join(folder, "plan.json");
  writeFileSync(planFile, JSON.stringify({ schemaVersion: 1, executionId: "selected", temporaryRoot: folder, prefix, cli, serverRoot, sourceVersion: "1.2.3",
    artifacts: [{ package: "paperclipai", version: "1.2.3", entrySha256: sha(cli) }, { package: "@paperclipai/server", version: "1.2.3", entrySha256: sha(server) }] }), { mode: 0o600 });
  const env = { [CHAT_INSTALL_PLAN]: planFile, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: folder };
  expect(refreshInstalledChatPins(env, "selected").version).toBe("1.2.3");
  expect(() => refreshInstalledChatPins(env, "other")).toThrow("another target");
  writeFileSync(server, "export const server='tampered';");
  expect(() => refreshInstalledChatPins(env, "selected")).toThrow("independently downloaded");
});

it("retires the exact timed-out preparation child while retaining only the owned partial prefix for disposition", async () => {
  const folder = root(), partial = path.join(folder, "partial-install.json");
  const source = `const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(${JSON.stringify(partial)},JSON.stringify({pid:process.pid,descendantPid:child.pid}));setInterval(()=>{},1000);`;
  await expect(runOwnedInstalledPreparation(process.execPath, ["-e", source], { cwd: folder, env: { PATH: process.env.PATH }, timeout: 500 })).rejects.toThrow("preparation failed");
  const { pid, descendantPid } = JSON.parse(readFileSync(partial, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(() => process.kill(descendantPid, 0)).toThrow();
  rmSync(folder, { recursive: true, force: true });
});
