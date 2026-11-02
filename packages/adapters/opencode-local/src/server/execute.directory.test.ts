import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform === "win32")("runs a CLI without --dir in the selected workspace despite a stale parent PWD", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-directory-")));
  roots.push(root);
  const workspace = path.join(root, "workspace with spaces");
  const command = path.join(root, "opencode.mjs");
  await fs.mkdir(workspace);
  await fs.writeFile(command, `#!${process.execPath}
if (process.argv.includes('--dir')) {
  process.stderr.write('Unrecognized flag: --dir in command opencode run\\n');
  process.exit(1);
}
for await (const chunk of process.stdin) {}
console.log(JSON.stringify({ type: 'text', sessionID: 'directory-test', part: {
  text: JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD }),
} }));
`, { mode: 0o755 });
  vi.stubEnv("PWD", "/stale-parent-workspace");
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  const result = await execute({
    runId: "directory-test",
    agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command, cwd: workspace, model: "openai/gpt-5",
      env: { HOME: root, OPENCODE_ALLOW_ALL_MODELS: "1", PWD: "/stale-config-workspace" },
      dangerouslySkipPermissions: false,
    },
    context: {},
    onLog: async () => {},
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.summary!)).toEqual({ cwd: workspace, pwd: workspace });
  expect(process.env.PWD).toBe("/stale-parent-workspace");
});
