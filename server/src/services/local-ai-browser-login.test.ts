import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLocalBrowserLogin } from "./local-ai-browser-login.js";
import { resolveCodexCommand } from "../vendor/paperclip-runner/index.js";

vi.mock("../vendor/paperclip-runner/index.js", () => ({
  resolveCodexCommand: vi.fn(),
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

async function fakeCli(name: string, source: string) {
  root ??= await mkdtemp(path.join(os.tmpdir(), "paperclip-browser-login-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  if (name === "codex") vi.mocked(resolveCodexCommand).mockReturnValue(path.join(bin, name));
  process.env.PATH = `${bin}${path.delimiter}${initialPath}`;
  const home = path.join(root, "credential-home");
  await mkdir(home, { mode: 0o700 });
  return realpath(home);
}

function targetPlatform(platform: string, architecture: string) {
  Object.defineProperty(process, "platform", { ...initialPlatform, value: platform });
  Object.defineProperty(process, "arch", { ...initialArchitecture, value: architecture });
}

describe.skipIf(process.platform === "win32")("local browser subscription login", () => {
  it.each([false, true])("uses the selected Codex command with its credential home and ambient HOME/cwd (legacy Linux ARM64: %s)", async (legacy) => {
    if (legacy) targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", [
      '[ "$1 $2" = "login --device-auth" ] || exit 11',
      '[ "$HOME" = "$CLAUDE_CONFIG_DIR" ] && [ "$HOME" != "$CODEX_HOME" ] && [ "$CODEX_HOME" = "$PAPERCLIP_TEST_LOGIN_CODEX_HOME" ] || exit 12',
      '[ "$PWD" = "$PAPERCLIP_TEST_LOGIN_CWD" ] || exit 13',
      '[ -z "$OPENAI_API_KEY$CODEX_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 14',
      'printf "1. Open this link in your browser and sign in to your account\\nhttps://auth.openai.com/codex/device\\n2. Enter this one-time code (expires in 15 minutes)\\nABCD-EFGHJ\\n"',
    ].join("\n"));
    if (legacy) vi.mocked(resolveCodexCommand).mockImplementation(() => { throw new Error("native artifact is unavailable"); });
    else process.env.PATH = "/usr/bin:/bin";
    const ambientHome = path.join(root!, "unrelated-host-home");
    await mkdir(ambientHome, { mode: 0o700 });
    for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) vi.stubEnv(key, ambientHome);
    vi.stubEnv("PAPERCLIP_TEST_LOGIN_CODEX_HOME", home);
    vi.stubEnv("PAPERCLIP_TEST_LOGIN_CWD", process.cwd());
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
      vi.stubEnv(key, "unrelated-host-value");
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    if (legacy) expect(resolveCodexCommand).not.toHaveBeenCalled();
    else expect(resolveCodexCommand).toHaveBeenCalledOnce();
    expect(login.code).toBe("ABCD-EFGHJ");
  });

  it.each([["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"]] as const)("reports an unavailable Codex CLI on %s/%s without revealing private details", async (platform, architecture) => {
    targetPlatform(platform, architecture);
    const home = await fakeCli("codex", 'echo invoked > "$CODEX_HOME/unreviewed-cli"');
    const failure = new Error("private-installation-path-or-provider-output");
    vi.mocked(resolveCodexCommand).mockImplementation(() => { throw failure; });
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires an installed Codex CLI.*Install Codex/);
    expect(JSON.stringify(login)).not.toContain(failure.message);
    await expect(readFile(path.join(home, "unreviewed-cli"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(login.authorizationUrl).toBeUndefined();
  });

  it("reports a missing Linux ARM64 Codex CLI without revealing the host PATH", async () => {
    targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", "exit 0");
    process.env.PATH = "/usr/bin:/bin";
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires the Codex CLI.*Install Codex.*Paperclip's PATH/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
    expect(resolveCodexCommand).not.toHaveBeenCalled();
  });

  it("reports a missing terminal prerequisite without exposing spawn details", async () => {
    const home = await fakeCli("codex", "exit 0");
    process.env.PATH = path.join(root!, "no-python");
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires Python 3.*Install Python 3/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
  });

  it("cancels before launching the resolved Codex command", async () => {
    const home = await fakeCli("codex", 'echo invoked > "$CODEX_HOME/cancelled-cli"');
    const login = startLocalBrowserLogin("openai", home);
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await expect(readFile(path.join(home, "cancelled-cli"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("accepts a Claude browser code and stores its token only in the attempt home", async () => {
    const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
    const home = await fakeCli("claude", [
      'printf "Welcome to Claude Code\\nOpening browser to sign in…\\nBrowser didn\x27t open? Use the url below to sign in (c to copy)\\n"',
      `printf '%s\\n' '${url}'`,
      'printf "Paste code here if prompted >\\n"',
      'read -r entered',
      'printf "✓ Long-lived authentication token created successfully!\\n\\nYour OAuth token (valid for 1 year):\\n\\nsk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII\\n\\nStore this token securely. You won\x27t be able to see it again.\\n"',
    ].join("\n"));
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    login.submitCode?.("fixture-code");
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    const credential = JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8"));
    expect(credential.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-/);
    expect((await stat(path.join(home, ".credentials.json"))).mode & 0o777).toBe(0o600);
  });

  it("terminates the local provider process when sign-in is cancelled", async () => {
    const home = await fakeCli("codex", 'echo $$ > "$CODEX_HOME/login.pid"\nexec sleep 60');
    const login = startLocalBrowserLogin("openai", home);
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(path.join(home, "login.pid"), "utf8")); expect(pid).toBeGreaterThan(0); });
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });

  it("cancels Claude while waiting for its browser code and terminates the provider", async () => {
    const home = await fakeCli("claude", [
      'echo $$ > "$CLAUDE_CONFIG_DIR/login.pid"',
      'printf "Welcome to Claude Code\\nOpening browser to sign in…\\nBrowser didn\x27t open? Use the url below to sign in (c to copy)\\n"',
      'printf "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%%3A%%2F%%2Fplatform.claude.com%%2Foauth%%2Fcode%%2Fcallback&response_type=code&scope=user&state=0123456789abcdef\\n"',
      'printf "Paste code here if prompted >\\n"',
      'read -r entered',
    ].join("\n"));
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
