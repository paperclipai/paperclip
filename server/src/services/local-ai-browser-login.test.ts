import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paperclipRunnerSupportsPlatform } from "@paperclipai/shared";
import { startLocalBrowserLogin } from "./local-ai-browser-login.js";
import { resolvePinnedClaudeCommand, resolvePinnedCodexCommand } from "../vendor/paperclip-runner/index.js";

vi.mock("../vendor/paperclip-runner/index.js", () => ({
  resolvePinnedClaudeCommand: vi.fn(),
  resolvePinnedCodexCommand: vi.fn(),
}));

const initialPath = process.env.PATH;
const initialPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const initialArchitecture = Object.getOwnPropertyDescriptor(process, "arch")!;
let root: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, "platform", initialPlatform);
  Object.defineProperty(process, "arch", initialArchitecture);
  process.env.PATH = initialPath;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function targetPlatform(platform: string, architecture: string) {
  Object.defineProperty(process, "platform", { ...initialPlatform, value: platform });
  Object.defineProperty(process, "arch", { ...initialArchitecture, value: architecture });
}

async function fakeCli(name: string, source: string) {
  root ??= await mkdtemp(path.join(os.tmpdir(), "paperclip-browser-login-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  if (name === "codex") vi.mocked(resolvePinnedCodexCommand).mockReturnValue(path.join(bin, name));
  else vi.mocked(resolvePinnedClaudeCommand).mockResolvedValue(path.join(bin, name));
  process.env.PATH = `${bin}${path.delimiter}${initialPath}`;
  const home = path.join(root, "credential-home");
  await mkdir(home, { mode: 0o700 });
  return realpath(home);
}

describe.skipIf(process.platform === "win32")("local browser subscription login", () => {
  it.each([
    ["qualified", false],
    ["legacy Linux ARM64", true],
  ] as const)("uses the %s Codex command and isolates every credential home", async (_name, legacy) => {
    if (legacy) targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", [
      '[ "$1 $2" = "login --device-auth" ] || exit 11',
      '[ "$HOME" = "$CODEX_HOME" ] && [ "$HOME" = "$CLAUDE_CONFIG_DIR" ] || exit 12',
      '[ "$PWD" = "$HOME" ] || exit 13',
      '[ -z "$OPENAI_API_KEY$CODEX_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 14',
      'printf "1. Open this link in your browser and sign in to your account\\nhttps://auth.openai.com/codex/device\\n2. Enter this one-time code (expires in 15 minutes)\\nABCD-EFGHJ\\n"',
    ].join("\n"));
    if (legacy) {
      expect(paperclipRunnerSupportsPlatform("codex_local", "linux", "arm64")).toBe(false);
      vi.mocked(resolvePinnedCodexCommand).mockImplementation(() => { throw new Error("native artifact is unavailable"); });
    } else process.env.PATH = "/usr/bin:/bin";
    const ambientHome = path.join(root!, "unrelated-host-home");
    await mkdir(ambientHome, { mode: 0o700 });
    for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
      vi.stubEnv(key, ambientHome);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
      vi.stubEnv(key, "unrelated-host-value");
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    if (legacy) expect(resolvePinnedCodexCommand).not.toHaveBeenCalled();
    else expect(resolvePinnedCodexCommand).toHaveBeenCalledOnce();
    expect(resolvePinnedClaudeCommand).not.toHaveBeenCalled();
    expect(login.code).toBe("ABCD-EFGHJ");
  });

  it.each([
    ["openai", "linux", "x64"],
    ["openai", "darwin", "arm64"],
    ["openai", "darwin", "x64"],
    ["anthropic", "linux", "x64"],
    ["anthropic", "darwin", "arm64"],
    ["anthropic", "darwin", "x64"],
  ] as const)("reports missing qualified %s artifacts on %s/%s without using an ambient CLI", async (provider, platform, architecture) => {
    targetPlatform(platform, architecture);
    const home = await fakeCli(provider === "openai" ? "codex" : "claude", provider === "openai"
      ? 'echo invoked > "$CODEX_HOME/unreviewed-cli"'
      : 'echo invoked > "$CLAUDE_CONFIG_DIR/unreviewed-cli"');
    const failure = new Error("private-installation-path-or-provider-output");
    if (provider === "openai") vi.mocked(resolvePinnedCodexCommand).mockImplementation(() => { throw failure; });
    else vi.mocked(resolvePinnedClaudeCommand).mockRejectedValue(failure);
    const login = startLocalBrowserLogin(provider, home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires the qualified runtime.*Reinstall Paperclip/);
    expect(JSON.stringify(login)).not.toContain(failure.message);
    await expect(readFile(path.join(home, "unreviewed-cli"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(login.authorizationUrl).toBeUndefined();
  });

  it.each(["anthropic", "openai"] as const)("reports the missing legacy %s CLI on native-unqualified Linux ARM64 without exposing the host PATH", async (provider) => {
    targetPlatform("linux", "arm64");
    const home = await fakeCli(provider === "anthropic" ? "claude" : "codex", 'echo invoked > "$HOME/unreviewed-cli"');
    process.env.PATH = "/usr/bin:/bin";
    if (provider === "anthropic") vi.mocked(resolvePinnedClaudeCommand).mockRejectedValue(new Error("native artifact is unavailable"));
    else vi.mocked(resolvePinnedCodexCommand).mockImplementation(() => { throw new Error("native artifact is unavailable"); });
    const login = startLocalBrowserLogin(provider, home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires the legacy .* CLI.*Install .*Paperclip's PATH/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
    expect(resolvePinnedClaudeCommand).not.toHaveBeenCalled();
    expect(resolvePinnedCodexCommand).not.toHaveBeenCalled();
    expect(login.authorizationUrl).toBeUndefined();
    await expect(readFile(path.join(home, "unreviewed-cli"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("reports a missing terminal prerequisite without exposing spawn details (legacy Linux ARM64: %s)", async (legacy) => {
    if (legacy) targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", "exit 0");
    process.env.PATH = path.join(root!, legacy ? "bin" : "no-python");
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires Python 3.*Install Python 3/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
  });

  it("does not launch a provider if cancellation occurs during qualified command resolution", async () => {
    const home = await fakeCli("claude", 'echo invoked > "$CLAUDE_CONFIG_DIR/late-provider"');
    let resolveCommand!: (command: string) => void;
    vi.mocked(resolvePinnedClaudeCommand).mockReturnValue(new Promise(resolve => { resolveCommand = resolve; }));
    const login = startLocalBrowserLogin("anthropic", home);
    login.abort();
    resolveCommand(path.join(root!, "bin", "claude"));
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await expect(readFile(path.join(home, "late-provider"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("surfaces a Codex device link and code from a local PTY without a user shell command", async () => {
    const home = await fakeCli("codex", [
      'printf "1. Open this link in your browser and sign in to your account\\n"',
      'printf "https://auth.openai.com/codex/device\\n"',
      'printf "2. Enter this one-time code (expires in 15 minutes)\\n"',
      'printf "ABCD-EFGHJ\\n"',
    ].join("\n"));
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    expect(login.authorizationUrl).toBe("https://auth.openai.com/codex/device");
    expect(login.code).toBe("ABCD-EFGHJ");
  });

  it.each([
    ["qualified Linux x64", "linux", "x64", false],
    ["qualified macOS ARM64", "darwin", "arm64", false],
    ["qualified macOS x64", "darwin", "x64", false],
    ["legacy Linux ARM64", "linux", "arm64", true],
  ] as const)("accepts a Claude browser code on %s and stores its token only in the isolated attempt home", async (_name, platform, architecture, legacy) => {
    targetPlatform(platform, architecture);
    expect(paperclipRunnerSupportsPlatform("claude_local", platform, architecture)).toBe(!legacy);
    const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
    const home = await fakeCli("claude", [
      '[ "$1" = "setup-token" ] || exit 11',
      '[ "$HOME" = "$CLAUDE_CONFIG_DIR" ] && [ "$HOME" = "$CODEX_HOME" ] || exit 12',
      '[ "$PWD" = "$HOME" ] || exit 13',
      '[ -z "$OPENAI_API_KEY$CODEX_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 14',
      'printf "Welcome to Claude Code\\nOpening browser to sign in…\\nBrowser didn\x27t open? Use the url below to sign in (c to copy)\\n"',
      `printf '%s\\n' '${url}'`,
      'printf "Paste code here if prompted >\\n"',
      'read -r entered',
      'printf "✓ Long-lived authentication token created successfully!\\n\\nYour OAuth token (valid for 1 year):\\n\\nsk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII\\n\\nStore this token securely. You won\x27t be able to see it again.\\n"',
    ].join("\n"));
    if (legacy) vi.mocked(resolvePinnedClaudeCommand).mockRejectedValue(new Error("native artifact is unavailable"));
    else process.env.PATH = "/usr/bin:/bin";
    const ambientHome = path.join(root!, "unrelated-host-home");
    await mkdir(ambientHome, { mode: 0o700 });
    for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
      vi.stubEnv(key, ambientHome);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
      vi.stubEnv(key, "unrelated-host-value");
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    login.submitCode?.("fixture-code");
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    const credential = JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8"));
    expect(credential.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-/);
    expect((await stat(path.join(home, ".credentials.json"))).mode & 0o777).toBe(0o600);
    if (legacy) expect(resolvePinnedClaudeCommand).not.toHaveBeenCalled();
    else expect(resolvePinnedClaudeCommand).toHaveBeenCalledOnce();
    await expect(readFile(path.join(ambientHome, ".credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("terminates the local Codex process when sign-in is cancelled (legacy Linux ARM64: %s)", async (legacy) => {
    if (legacy) targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", 'echo $$ > "$CODEX_HOME/login.pid"\nexec sleep 60');
    if (legacy) vi.mocked(resolvePinnedCodexCommand).mockImplementation(() => { throw new Error("native artifact is unavailable"); });
    const login = startLocalBrowserLogin("openai", home);
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(path.join(home, "login.pid"), "utf8")); expect(pid).toBeGreaterThan(0); });
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });

  it.each([false, true])("cancels Claude while waiting for its browser code and terminates the provider (legacy Linux ARM64: %s)", async (legacy) => {
    if (legacy) targetPlatform("linux", "arm64");
    const home = await fakeCli("claude", [
      'echo $$ > "$CLAUDE_CONFIG_DIR/login.pid"',
      'printf "Welcome to Claude Code\\nOpening browser to sign in…\\nBrowser didn\x27t open? Use the url below to sign in (c to copy)\\n"',
      'printf "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%%3A%%2F%%2Fplatform.claude.com%%2Foauth%%2Fcode%%2Fcallback&response_type=code&scope=user&state=0123456789abcdef\\n"',
      'printf "Paste code here if prompted >\\n"',
      'read -r entered',
    ].join("\n"));
    if (legacy) vi.mocked(resolvePinnedClaudeCommand).mockRejectedValue(new Error("native artifact is unavailable"));
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    const pid = Number(await readFile(path.join(home, "login.pid"), "utf8"));
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    await expect(readFile(path.join(home, ".credentials.json"))).rejects.toThrow();
  });

  it("returns a fixed failure without exposing provider error output", async () => {
    const home = await fakeCli("codex", 'echo "private-provider-error" >&2\nexit 1');
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(JSON.stringify(login)).not.toContain("private-provider-error");
    expect(login.authorizationUrl).toBeUndefined();
  });
});
