import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  execute,
  isClaudeLocalGitIdentityEnabled,
  parseClaudeLocalGitConfig,
  prepareGitIdentityRuntime,
} from "@paperclipai/adapter-claude-local/server";
import { redactSensitiveText } from "../redaction.js";

async function writeGitInspectingClaudeCommand(commandPath: string): Promise<void> {
  // The fake claude binary writes the git-related env vars + the contents of
  // the per-run .gitconfig back to a capture file so the test can assert on
  // what the agent process would actually see.
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
let gitconfigContents = null;
if (process.env.GIT_CONFIG_GLOBAL) {
  try {
    gitconfigContents = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, "utf8");
  } catch (err) {
    gitconfigContents = "ERROR:" + err.message;
  }
}
const payload = {
  argv: process.argv.slice(2),
  env: {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? null,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? null,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? null,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? null,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? null,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
  },
  gitconfigContents,
  pid: process.pid,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

interface ExecHarness {
  workspace: string;
  commandPath: string;
  capturePath: string;
  hostGitconfig: string;
  hostGitconfigSentinel: string;
  runtimeRoot: string;
  restore: () => void;
}

async function setupExecuteEnv(root: string): Promise<ExecHarness> {
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const commandPath = path.join(binDir, "claude");
  const capturePath = path.join(root, "capture.json");
  const hostHome = path.join(root, "home");
  const hostGitconfig = path.join(hostHome, ".gitconfig");
  const hostGitconfigSentinel = "[user]\n\tname = host-original\n\temail = host@example.com\n";
  const runtimeRoot = path.join(root, "git-identity-runtime");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(hostHome, { recursive: true });
  await fs.writeFile(hostGitconfig, hostGitconfigSentinel, "utf8");
  await writeGitInspectingClaudeCommand(commandPath);
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousFlag = process.env.PAPERCLIP_ADAPTER_GIT_IDENTITY;
  process.env.HOME = hostHome;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    workspace,
    commandPath,
    capturePath,
    hostGitconfig,
    hostGitconfigSentinel,
    runtimeRoot,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousFlag === undefined) delete process.env.PAPERCLIP_ADAPTER_GIT_IDENTITY;
      else process.env.PAPERCLIP_ADAPTER_GIT_IDENTITY = previousFlag;
    },
  };
}

describe("claude_local git identity feature flag", () => {
  it("isClaudeLocalGitIdentityEnabled defaults to false", () => {
    expect(isClaudeLocalGitIdentityEnabled({})).toBe(false);
    expect(isClaudeLocalGitIdentityEnabled({ PAPERCLIP_ADAPTER_GIT_IDENTITY: "false" })).toBe(false);
    expect(isClaudeLocalGitIdentityEnabled({ PAPERCLIP_ADAPTER_GIT_IDENTITY: "0" })).toBe(false);
    expect(isClaudeLocalGitIdentityEnabled({ PAPERCLIP_ADAPTER_GIT_IDENTITY: "" })).toBe(false);
  });

  it("isClaudeLocalGitIdentityEnabled is true for truthy values", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(isClaudeLocalGitIdentityEnabled({ PAPERCLIP_ADAPTER_GIT_IDENTITY: value })).toBe(true);
    }
  });
});

describe("claude_local git identity schema", () => {
  it("rejects non-object values", () => {
    const result = parseClaudeLocalGitConfig("paperclip-foundingeng");
    expect(result.config).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects missing or invalid email", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "paperclip-foundingeng",
      userEmail: "not-an-email",
    });
    expect(result.config).toBeNull();
    expect(result.errors.find((e) => e.field === "userEmail")).toBeDefined();
  });

  it("rejects unsupported tokenSecretRef schemes", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "x",
      userEmail: "x@y.com",
      tokenSecretRef: "vault://secret",
    });
    expect(result.config).toBeNull();
    expect(result.errors.find((e) => e.field === "tokenSecretRef")).toBeDefined();
  });

  it("accepts a valid config with env: token ref", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "paperclip-foundingeng",
      userEmail: "paperclip+foundingeng@openstudio.fr",
      tokenSecretRef: "env:PAPERCLIP_GH_TOKEN_FOUNDINGENG",
    });
    expect(result.errors).toEqual([]);
    expect(result.config).toEqual({
      userName: "paperclip-foundingeng",
      userEmail: "paperclip+foundingeng@openstudio.fr",
      tokenSecretRef: "env:PAPERCLIP_GH_TOKEN_FOUNDINGENG",
    });
  });

  it("accepts an absent tokenSecretRef", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "x",
      userEmail: "x@y.com",
    });
    expect(result.config).toEqual({
      userName: "x",
      userEmail: "x@y.com",
      tokenSecretRef: null,
    });
  });
});

describe("claude_local prepareGitIdentityRuntime isolation", () => {
  it("writes a per-run .gitconfig and never touches the host ~/.gitconfig", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-identity-iso-"));
    const hostHome = path.join(root, "home");
    const hostGitconfig = path.join(hostHome, ".gitconfig");
    const hostSentinel = "[user]\n\tname = host-original\n\temail = host@example.com\n";
    await fs.mkdir(hostHome, { recursive: true });
    await fs.writeFile(hostGitconfig, hostSentinel, "utf8");
    try {
      const result = await prepareGitIdentityRuntime({
        runId: "run-1",
        agentId: "agent-A",
        cwd: root,
        config: {
          userName: "paperclip-foundingeng",
          userEmail: "paperclip+foundingeng@openstudio.fr",
          tokenSecretRef: "env:GH_TOK_AGENT_A",
        },
        resolveToken: async (ref) => (ref === "env:GH_TOK_AGENT_A" ? "ghp_agentApat0000000000000000" : null),
        runtimeRoot: path.join(root, "runtime"),
      });
      expect(result.env.GIT_AUTHOR_NAME).toBe("paperclip-foundingeng");
      expect(result.env.GIT_AUTHOR_EMAIL).toBe("paperclip+foundingeng@openstudio.fr");
      expect(result.env.GIT_COMMITTER_NAME).toBe("paperclip-foundingeng");
      expect(result.env.GIT_COMMITTER_EMAIL).toBe("paperclip+foundingeng@openstudio.fr");
      expect(result.env.GH_TOKEN).toBe("ghp_agentApat0000000000000000");
      expect(result.env.GIT_CONFIG_GLOBAL).toBe(result.gitConfigPath);
      const gitconfigBody = await fs.readFile(result.gitConfigPath, "utf8");
      expect(gitconfigBody).toContain('name = "paperclip-foundingeng"');
      expect(gitconfigBody).toContain("https://github.com");
      expect(gitconfigBody).toContain("password=$GH_TOKEN");
      // Host ~/.gitconfig must remain unchanged.
      const hostBodyAfter = await fs.readFile(hostGitconfig, "utf8");
      expect(hostBodyAfter).toBe(hostSentinel);
      // The PAT itself must not appear inside the per-run .gitconfig — the helper
      // shells out to $GH_TOKEN, never embeds the literal token.
      expect(gitconfigBody).not.toContain("ghp_agentApat0000000000000000");
      // chmod 600 on the file (best-effort, skipped on platforms without it).
      const stat = await fs.stat(result.gitConfigPath);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
      }
      await result.cleanup();
      await expect(fs.stat(result.gitConfigPath)).rejects.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates two parallel agents — distinct GH_TOKEN values and distinct GIT_CONFIG_GLOBAL paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-identity-cross-"));
    try {
      const runtimeRoot = path.join(root, "runtime");
      const [a, b] = await Promise.all([
        prepareGitIdentityRuntime({
          runId: "run-A",
          agentId: "agent-A",
          cwd: root,
          config: {
            userName: "agent-a",
            userEmail: "a@x.com",
            tokenSecretRef: "env:GH_TOK_A",
          },
          resolveToken: async (ref) => (ref === "env:GH_TOK_A" ? "ghp_AAAAAAAAAAAAAAAAAAAAAA" : null),
          runtimeRoot,
        }),
        prepareGitIdentityRuntime({
          runId: "run-B",
          agentId: "agent-B",
          cwd: root,
          config: {
            userName: "agent-b",
            userEmail: "b@x.com",
            tokenSecretRef: "env:GH_TOK_B",
          },
          resolveToken: async (ref) => (ref === "env:GH_TOK_B" ? "ghp_BBBBBBBBBBBBBBBBBBBBBB" : null),
          runtimeRoot,
        }),
      ]);
      expect(a.gitConfigPath).not.toBe(b.gitConfigPath);
      expect(a.env.GH_TOKEN).toBe("ghp_AAAAAAAAAAAAAAAAAAAAAA");
      expect(b.env.GH_TOKEN).toBe("ghp_BBBBBBBBBBBBBBBBBBBBBB");
      const aBody = await fs.readFile(a.gitConfigPath, "utf8");
      const bBody = await fs.readFile(b.gitConfigPath, "utf8");
      expect(aBody).toContain('name = "agent-a"');
      expect(bBody).toContain('name = "agent-b"');
      // Cross-agent sanitizer: the gitconfig of agent A must not embed the PAT of B (or its own).
      expect(aBody).not.toContain("ghp_BBBBBBBBBBBBBBBBBBBBBB");
      expect(aBody).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAA");
      expect(bBody).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAA");
      expect(bBody).not.toContain("ghp_BBBBBBBBBBBBBBBBBBBBBB");
      await Promise.all([a.cleanup(), b.cleanup()]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("warns and skips GH_TOKEN injection when tokenSecretRef does not resolve", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-identity-noresolve-"));
    try {
      const result = await prepareGitIdentityRuntime({
        runId: "run-noresolve",
        agentId: "agent-noresolve",
        cwd: root,
        config: {
          userName: "x",
          userEmail: "x@y.com",
          tokenSecretRef: "env:DOES_NOT_EXIST_ABC",
        },
        resolveToken: async () => null,
        runtimeRoot: path.join(root, "runtime"),
      });
      expect(result.env.GH_TOKEN).toBeUndefined();
      expect(result.warnings.length).toBeGreaterThan(0);
      const body = await fs.readFile(result.gitConfigPath, "utf8");
      // Without a resolved token, the credential helper section is omitted.
      expect(body).not.toContain("https://github.com");
      await result.cleanup();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude_local execute git identity end-to-end", () => {
  it("does not inject git env when feature flag is off, even with adapterConfig.git present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-git-off-"));
    const harness = await setupExecuteEnv(root);
    delete process.env.PAPERCLIP_ADAPTER_GIT_IDENTITY;
    try {
      await execute({
        runId: "run-off",
        agent: { id: "agent-off", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: harness.commandPath,
          cwd: harness.workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: harness.capturePath },
          promptTemplate: "Do work.",
          git: {
            userName: "paperclip-foundingeng",
            userEmail: "paperclip+foundingeng@openstudio.fr",
            tokenSecretRef: "env:GH_TOK_OFF",
          },
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const captured = JSON.parse(await fs.readFile(harness.capturePath, "utf8"));
      expect(captured.env.GIT_AUTHOR_NAME).toBeNull();
      expect(captured.env.GIT_CONFIG_GLOBAL).toBeNull();
      expect(captured.env.GH_TOKEN).toBeNull();
      // Host ~/.gitconfig is untouched.
      expect(await fs.readFile(harness.hostGitconfig, "utf8")).toBe(harness.hostGitconfigSentinel);
    } finally {
      harness.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects per-run gitconfig + GH_TOKEN when feature flag is on, isolating from host ~/.gitconfig", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-git-on-"));
    const harness = await setupExecuteEnv(root);
    process.env.PAPERCLIP_ADAPTER_GIT_IDENTITY = "true";
    process.env.GH_TOK_AGENT_FE = "ghp_pat_inject0000000000000000";
    try {
      await execute({
        runId: "run-on",
        agent: {
          id: "agent-fe",
          companyId: "co-1",
          name: "Founding Engineer",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: harness.commandPath,
          cwd: harness.workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: harness.capturePath },
          promptTemplate: "Do work.",
          git: {
            userName: "paperclip-foundingeng",
            userEmail: "paperclip+foundingeng@openstudio.fr",
            tokenSecretRef: "env:GH_TOK_AGENT_FE",
          },
        },
        context: {
          paperclipAdapterGitIdentity: { runtimeRoot: harness.runtimeRoot },
        },
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const captured = JSON.parse(await fs.readFile(harness.capturePath, "utf8"));
      expect(captured.env.GIT_AUTHOR_NAME).toBe("paperclip-foundingeng");
      expect(captured.env.GIT_AUTHOR_EMAIL).toBe("paperclip+foundingeng@openstudio.fr");
      expect(captured.env.GIT_COMMITTER_NAME).toBe("paperclip-foundingeng");
      expect(captured.env.GIT_COMMITTER_EMAIL).toBe("paperclip+foundingeng@openstudio.fr");
      expect(captured.env.GH_TOKEN).toBe("ghp_pat_inject0000000000000000");
      expect(typeof captured.env.GIT_CONFIG_GLOBAL).toBe("string");
      expect(captured.env.GIT_CONFIG_GLOBAL.startsWith(harness.runtimeRoot)).toBe(true);
      expect(captured.gitconfigContents).toContain('name = "paperclip-foundingeng"');
      expect(captured.gitconfigContents).toContain("https://github.com");
      expect(captured.gitconfigContents).not.toContain("ghp_pat_inject0000000000000000");
      // Host ~/.gitconfig still untouched.
      expect(await fs.readFile(harness.hostGitconfig, "utf8")).toBe(harness.hostGitconfigSentinel);
    } finally {
      delete process.env.GH_TOK_AGENT_FE;
      harness.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("redaction: GitHub PATs are never echoed in logs", () => {
  it("redacts ghp_ classic and github_pat_ fine-grained tokens via redactSensitiveText", () => {
    const classic = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const fineGrained =
      "github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    const sample = `Pushing with token ${classic} and fine-grained ${fineGrained} should never appear in logs.`;
    const redacted = redactSensitiveText(sample);
    expect(redacted).not.toContain(classic);
    expect(redacted).not.toContain(fineGrained);
    expect(redacted).toContain("***REDACTED***");
  });
});
