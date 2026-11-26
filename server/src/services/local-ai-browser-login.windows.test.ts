import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as nodePty from "@lydell/node-pty";
import { startLocalBrowserLogin } from "./local-ai-browser-login.js";

vi.mock("../vendor/paperclip-runner/index.js", () => ({
  resolveCodexCommand: vi.fn(),
  startAntigravityBrowserLogin: vi.fn(),
}));
vi.mock("@lydell/node-pty", () => ({ spawn: vi.fn() }));

const initialPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
const token = "sk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII";

let home: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, "platform", initialPlatform);
  vi.clearAllMocks();
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

const ESC = String.fromCharCode(27);
const ST = `${ESC}${String.fromCharCode(92)}`;

// What a real ConPTY emits for `claude setup-token`: absolute cursor moves
// instead of newlines or spaces, and an OSC 8 hyperlink that carries the URL.
const conptyBanner = [
  `${ESC}[2J${ESC}[1;1HWelcome to Claude Code${ESC}[3;1H`,
  `${ESC}[38;2;153;153;153mBrowser didn't open? Use the url below to sign in (c to copy)`,
  `${ESC}]8;id=u-1;${url}${ST}${url.slice(0, 100)}\r\n${url.slice(100)}${ESC}[m${ESC}]8;;${ST}`,
  `${ESC}[6;1HPaste code here if prompted >`,
].join("");

// A fake ConPTY session that behaves like `claude setup-token`.
function fakeClaudePty() {
  let onData: (chunk: string) => void = () => {};
  let onExit: (event: { exitCode: number; signal?: number }) => void = () => {};
  const written: string[] = [];
  const session = {
    onData: (listener: typeof onData) => {
      onData = listener;
      // Emit the banner only once the server is listening, like a real terminal.
      // Split mid-escape to prove the driver buffers partial sequences.
      setTimeout(() => { onData(conptyBanner.slice(0, 7)); onData(conptyBanner.slice(7)); }, 10);
      return { dispose() {} };
    },
    onExit: (listener: typeof onExit) => { onExit = listener; return { dispose() {} }; },
    write: vi.fn((input: string) => {
      written.push(input);
      // The runner writes the code, then the Return as its own write.
      if (written.some((entry) => entry.includes("fixture-code")) && /^[\r\n]+$/.test(input)) {
        onData(`✓ Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n${token}\r\n\r\nStore this token securely. You won't be able to see it again.\r\n`);
        onExit({ exitCode: 0 });
      }
    }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
  return { session, written };
}

describe("local browser subscription login on native Windows", () => {
  it("signs in to Claude through a ConPTY instead of python3", async () => {
    Object.defineProperty(process, "platform", { ...initialPlatform, value: "win32" });
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-login-"));
    const { session } = fakeClaudePty();
    vi.mocked(nodePty.spawn).mockReturnValue(session as never);

    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    login.submitCode?.("fixture-code");
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });

    expect(login.error).toBeUndefined();
    expect(nodePty.spawn).toHaveBeenCalledOnce();
    const [file, args, options] = vi.mocked(nodePty.spawn).mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(path.basename(file).toLowerCase()).toMatch(/^claude(\.exe|\.cmd)?$/);
    expect(args).toEqual(["setup-token"]);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(options.env.ANTHROPIC_API_KEY).toBe("");
    expect(options.env.BROWSER).toBe("true");

    const credential = JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8"));
    expect(credential.claudeAiOauth.accessToken).toBe(token);
  });

  it("keeps the characters ConPTY skips over when it redraws a line", async () => {
    Object.defineProperty(process, "platform", { ...initialPlatform, value: "win32" });
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-login-"));
    const { session } = fakeClaudePty();
    // Replace the plain-text success output with a ConPTY redraw that skips
    // cells whose characters are already on screen (cursor-forward moves).
    session.write.mockImplementation((input: string) => {
      if (!/^[\r\n]+$/.test(input)) return;
      const line = "Store this token securely. You won't be able to see it again.";
      const cup = (row: number) => `${ESC}[${row};1H`;
      emit(`${ESC}[2J${cup(9)}${line}`);
      emit(`${cup(2)}✓ Long-lived authentication token created successfully!${cup(4)}Your OAuth token (valid for 1 year):${cup(6)}${token}${cup(9)}Stor${ESC}[1C this tok${ESC}[1Cn securely.${ESC}[1C${line.slice(line.indexOf("You"))}`);
      exit();
    });
    let emit: (chunk: string) => void = () => {};
    let exit: () => void = () => {};
    const original = session.onData;
    session.onData = (listener) => { emit = listener; return original(listener); };
    const originalExit = session.onExit;
    session.onExit = (listener) => { exit = () => listener({ exitCode: 0 }); return originalExit(listener); };
    vi.mocked(nodePty.spawn).mockReturnValue(session as never);

    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    login.submitCode?.("fixture-code");
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    const credential = JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8"));
    expect(credential.claudeAiOauth.accessToken).toBe(token);
  });

  it("kills the ConPTY process when sign-in is cancelled", async () => {
    Object.defineProperty(process, "platform", { ...initialPlatform, value: "win32" });
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-win-login-"));
    const { session } = fakeClaudePty();
    vi.mocked(nodePty.spawn).mockReturnValue(session as never);

    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    await login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(session.kill).toHaveBeenCalled();
  });
});
