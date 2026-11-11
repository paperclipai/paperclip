import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openWithConnectFailures(failures: string) {
  const root = await mkdtemp(join(tmpdir(), "opencode-paperclip-tools-"));
  const workspace = await mkdtemp(join(tmpdir(), "opencode-paperclip-tools-ws-"));
  roots.push(root, workspace);
  const command = join(root, "fake-opencode.mjs");
  await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
  await chmod(command, 0o755);
  const runtimeDirectory = join(root, "runtime");
  const dataHome = join(runtimeDirectory, "tools", "data");
  await mkdir(dataHome, { recursive: true });
  await writeFile(join(dataHome, "fake-mcp-connect-failures"), failures);
  const diagnostics: string[] = [];
  const driver = new OpenCodeServerDriver({
    model: "openrouter/controlled-model",
    runtimeDirectory,
    command,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const opened = await driver.openSession({
    runId: "run-tools",
    normalizedSessionId: "tools",
    workingDirectory: workspace,
  }).then((session) => ({ session, error: null }), (error: unknown) => ({ session: null, error: String(error) }));
  const connects = (await readFile(join(dataHome, "fake-mcp-connects.log"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).length;
  return { ...opened, diagnostics, connects };
}

it("reconnects the Paperclip tools when OpenCode's first MCP connect fails", async () => {
  const { session, error, diagnostics, connects } = await openWithConnectFailures("1");
  expect(error).toBeNull();
  expect(connects).toBe(2);
  expect(diagnostics.join("\n")).toContain("OpenCode reported the Paperclip tools as failed (Failed to get tools); reconnecting");
  await session?.close({ reason: "test" });
});

it("restarts OpenCode when its Paperclip tools stay unavailable", async () => {
  const { session, error, diagnostics, connects } = await openWithConnectFailures("3");
  expect(error).toBeNull();
  expect(connects).toBe(4);
  expect(diagnostics.join("\n")).toContain("OpenCode session startup attempt 1 failed; retrying.");
  await session?.close({ reason: "test" });
});

it("reconnects the Paperclip tools when a saved session resumes in a new OpenCode process", async () => {
  const { session, connects } = await openWithConnectFailures("0");
  expect(connects).toBe(1);
  const snapshot = await session!.snapshot();
  await session!.close({ reason: "restart" });
  const dataHome = join(roots[0]!, "runtime", "tools", "data");
  await writeFile(join(dataHome, "fake-mcp-connect-failures"), "1");
  const driver = new OpenCodeServerDriver({
    model: "openrouter/controlled-model",
    runtimeDirectory: join(roots[0]!, "runtime"),
    command: join(roots[0]!, "fake-opencode.mjs"),
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
  });
  const recovered = await driver.recoverSession!(snapshot);
  expect(recovered).toMatchObject({ recovered: true });
  const log = await readFile(join(dataHome, "fake-mcp-connects.log"), "utf8");
  expect(log.split("\n").filter(Boolean)).toHaveLength(3);
  await recovered.session?.close({ reason: "test" });
});

it("fails the session visibly instead of starting it without Paperclip tools", async () => {
  const { session, error } = await openWithConnectFailures("always");
  expect(session).toBeNull();
  expect(error).toContain("paperclip_tools_unavailable: OpenCode could not load the Paperclip tools (failed: Failed to get tools)");
});

it("keeps the named failure when OpenCode's MCP status cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-paperclip-tools-"));
  const workspace = await mkdtemp(join(tmpdir(), "opencode-paperclip-tools-ws-"));
  roots.push(root, workspace);
  const command = join(root, "fake-opencode.mjs");
  await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
  await chmod(command, 0o755);
  const driver = new OpenCodeServerDriver({
    model: "openrouter/controlled-model",
    runtimeDirectory: join(root, "runtime"),
    command,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === "/mcp") throw new Error("socket hang up");
      return fetch(input, init);
    },
  });
  const error = await driver.openSession({
    runId: "run-tools",
    normalizedSessionId: "tools",
    workingDirectory: workspace,
  }).then(() => "session unexpectedly started", (cause: unknown) => String(cause));
  expect(error).toContain("paperclip_tools_unavailable: OpenCode could not load the Paperclip tools (unreachable: OpenCode API /mcp request failed");
});
