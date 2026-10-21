import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
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
  vi.restoreAllMocks();
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

function targetPlatform(platform: string, architecture: string, glibc = true, glibcVersionRuntime = "2.39") {
  Object.defineProperty(process, "platform", { ...initialPlatform, value: platform });
  Object.defineProperty(process, "arch", { ...initialArchitecture, value: architecture });
  if (platform === "linux") vi.spyOn(process.report, "getReport").mockReturnValue({ header: glibc ? { glibcVersionRuntime } : {} } as never);
}

function resolveFixtureCodexCommand(home: string): string {
  const source = `
    import { resolveCodexCommand } from ${JSON.stringify(new URL("../../../packages/paperclip-runner/src/drivers/codex/codex-command.ts", import.meta.url).href)};
    try { console.log(JSON.stringify({ command: resolveCodexCommand(${JSON.stringify(path.join(root!, "issuer.js"))}, { PATH: "/missing-codex" }, ${JSON.stringify(home)}) })); }
    catch (error) { console.log(JSON.stringify({ error: error.message })); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, [
    "--no-global-search-paths", "--import", createRequire(import.meta.url).resolve("tsx"),
    "--input-type=module", "--eval", source,
  ], { cwd: root, env: { PATH: "/usr/bin:/bin", NODE_PATH: "", NODE_OPTIONS: "" },
    encoding: "utf8", timeout: 10000, maxBuffer: 16384 }));
  if (typeof result.error === "string") throw new Error(result.error);
  if (typeof result.command !== "string") throw new Error("Fixture resolver returned no executable");
  return result.command;
}

describe.skipIf(process.platform === "win32")("local browser subscription login", () => {
  it.each(["native", "arm32", "musl", "glibc-2.38", "glibc-3.0", "unknown"])("uses the selected Codex command with its credential home and ambient HOME/cwd (%s)", async platform => {
    const legacy = platform === "arm32";
    if (platform === "native") targetPlatform("linux", "x64");
    if (platform === "arm32") targetPlatform("linux", "arm");
    if (platform === "musl") targetPlatform("linux", "arm64", false);
    if (platform === "glibc-2.38") targetPlatform("linux", "arm64", true, "2.38");
    if (platform === "glibc-3.0") targetPlatform("linux", "arm64", true, "3.0");
    if (platform === "unknown") targetPlatform("linux", "x64", true, "unknown");
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
    await vi.waitFor(() => expect(login.outcome).toBeDefined(), { timeout: 5000 });
    expect(login.outcome).toBe("success");
    if (legacy) expect(resolveCodexCommand).not.toHaveBeenCalled();
    else expect(resolveCodexCommand).toHaveBeenCalledOnce();
    expect(login.code).toBe("ABCD-EFGHJ");
  });

  it.each(["x64", "arm64"].flatMap(architecture => ["2.38", "musl", "unknown"].map(libc => ({ architecture, libc }))))("uses the installed Codex dependency for login on Linux $architecture/$libc without a global CLI", async ({ architecture, libc }) => {
    targetPlatform("linux", architecture, libc !== "musl", libc);
    const home = await fakeCli("codex", [
      'echo owned > "$CODEX_HOME/owned-cli"',
      'printf "1. Open this link in your browser and sign in to your account\\nhttps://auth.openai.com/codex/device\\n2. Enter this one-time code (expires in 15 minutes)\\nABCD-EFGHJ\\n"',
    ].join("\n"));
    const dependency = path.join(root!, "node_modules/@openai/codex");
    await mkdir(path.join(dependency, "bin"), { recursive: true });
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.1.0", bin: { codex: "bin/codex" } }));
    await writeFile(path.join(dependency, "bin/codex"), await readFile(path.join(root!, "bin/codex")), { mode: 0o700 });
    const command = resolveFixtureCodexCommand(home);
    expect(command).toBe(await realpath(path.join(dependency, "bin/codex")));
    vi.mocked(resolveCodexCommand).mockReturnValue(command);
    process.env.PATH = "/usr/bin:/bin";
    const login = startLocalBrowserLogin("openai", home);
    try {
      await vi.waitFor(() => expect(login.outcome).toBeDefined(), { timeout: 5000 });
      expect(login.outcome).toBe("success");
      expect(await readFile(path.join(home, "owned-cli"), "utf8")).toBe("owned\n");
      expect(resolveCodexCommand).toHaveBeenCalledOnce();
      expect(process.report.getReport).not.toHaveBeenCalled();
    } finally { login.abort(); }
  });

  it.each(["2.38", "musl", "unknown"])("reports a real owned-dependency containment failure on Linux/%s without falling back to another CLI", async libc => {
    targetPlatform("linux", "arm64", libc !== "musl", libc);
    const home = await fakeCli("codex", 'echo invoked > "$CODEX_HOME/unreviewed-cli"');
    const dependency = path.join(root!, "node_modules/@openai/codex");
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.1.0", bin: { codex: "../outside-codex" } }));
    let resolutionError: unknown;
    try { resolveFixtureCodexCommand(home); } catch (error) { resolutionError = error; }
    expect(resolutionError).toBeInstanceOf(Error);
    expect((resolutionError as Error).message).toContain("executable escapes its package");
    vi.mocked(resolveCodexCommand).mockImplementation(() => { throw resolutionError; });
    const login = startLocalBrowserLogin("openai", home);
    try {
      await vi.waitFor(() => expect(login.outcome).toBeDefined(), { timeout: 5000 });
      expect(login.outcome).toBe("failure");
      expect(login.error).toMatch(/requires an installed Codex CLI.*Install Codex/);
      expect(JSON.stringify(login)).not.toContain(root!);
      await expect(readFile(path.join(home, "unreviewed-cli"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(resolveCodexCommand).toHaveBeenCalledOnce();
    } finally { login.abort(); }
  });

  it.each([["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"], ["darwin", "x64"]] as const)("reports an unavailable Codex CLI on %s/%s without revealing private details", async (platform, architecture) => {
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

  it("reports a missing Linux ARM32 Codex CLI without revealing the host PATH", async () => {
    targetPlatform("linux", "arm");
    const home = await fakeCli("codex", "exit 0");
    process.env.PATH = "/usr/bin:/bin";
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires the Codex CLI.*Install Codex.*Paperclip's PATH/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
    expect(resolveCodexCommand).not.toHaveBeenCalled();
  });

  it("reports a missing terminal prerequisite without exposing spawn details", async () => {
    targetPlatform("linux", "x64");
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
