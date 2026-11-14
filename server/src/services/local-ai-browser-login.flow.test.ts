import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(async () => "C:\\Program Files\\Claude's CLI\\claude.cmd") }));
vi.mock("node-pty", () => ({ spawn: mocks.spawn }));
vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  ensureCommandResolvable: vi.fn(async () => {}),
  resolveCommandForLogs: mocks.resolve,
}));
vi.mock("../vendor/paperclip-runner/index.js", () => ({ resolveCodexCommand: vi.fn() }));

import { startLocalBrowserLogin } from "./local-ai-browser-login.js";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
const token = "sk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII";
let home: string | undefined;

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.clearAllMocks();
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe("Windows Claude subscription sign-in flow", () => {
  it("surfaces a ConPTY login link, submits the browser code, and reads the saved credential", async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-login-flow-")));
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    let onData!: (data: string) => void;
    let onExit!: (event: { exitCode: number }) => void;
    const writes: string[] = [];
    const terminal = {
      onData: vi.fn((listener) => { onData = listener; }),
      onExit: vi.fn((listener) => { onExit = listener; }),
      write: vi.fn((input: string) => {
        writes.push(input);
        if (input === "\r") {
          onData(`\x1b[2;1HYour OAuth token (valid for 1 year):\x1b[4;1H${token}\x1b[6;1HStore this token securely. You won't be able to see it again.`);
          onExit({ exitCode: 0 });
        }
      }),
      kill: vi.fn(),
    };
    mocks.spawn.mockReturnValue(terminal);
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(terminal.onExit).toHaveBeenCalledOnce());
    const [file, args] = mocks.spawn.mock.calls[0];
    expect(file).toBe("powershell.exe");
    expect(Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le"))
      .toBe("& 'C:\\Program Files\\Claude''s CLI\\claude.cmd' 'setup-token'");
    const prompt = `Browser didn't open? Use the url below to sign in (c to copy)\x1b[22;1H${url}\x1b[29;2HPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>`;
    for (let i = 0; i < prompt.length; i += 7) onData(prompt.slice(i, i + 7));
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url));
    expect(login.outcome).toBeUndefined();
    login.submitCode!("synthetic-browser-code");
    await vi.waitFor(() => expect(login.outcome).toBe("success"));
    expect(writes).toEqual(["synthetic-browser-code", "\r"]);
    expect(terminal.kill).toHaveBeenCalledOnce();
    expect(JSON.parse(await readLocalAiCredentialFile(path.join(home, ".credentials.json"))))
      .toEqual({ claudeAiOauth: { accessToken: token } });
  });

  it("reports a failed terminal launch without retaining provider output", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    mocks.spawn.mockImplementationOnce(() => { throw new Error("sensitive-provider-output"); });
    const login = startLocalBrowserLogin("anthropic", "C:\\private\\login");
    await vi.waitFor(() => expect(login.outcome).toBe("failure"));
    expect(login.error).toContain("ConPTY");
    expect(JSON.stringify(login)).not.toContain("sensitive-provider-output");
  });
});
